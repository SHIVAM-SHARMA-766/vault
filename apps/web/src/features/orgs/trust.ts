// Signed key grants, the member's side (decisions/0025). Before using a
// collection key, the app checks the grant's signature against an admin it
// trusts: the organization owner, pinned in a trust store sealed with this
// account's vault key, and admins the owner has endorsed. A grant signed by
// anyone else, or altered, is refused. Unsigned grants (from before signing)
// are accepted until this account has seen its grants fully signed once;
// after that they are refused too, so a server cannot quietly go back.

import {
  endorsementBytes, fromBase64Url, fullFingerprint, identityFingerprint, sealJson, unsealJson, utf8Encode, verifyBytes, verifyGrant,
} from '@vault/crypto'

import { type OrgMember, api } from '../../lib/api.js'
import * as session from '../../lib/session.js'

export interface TrustStore {
  /** The owner's signing key as first seen (base64url), and whose. */
  ownerSigningKey?: string
  ownerId?: string
  /** Set once every grant this account holds in the org verified. */
  requireSigned?: boolean
}

const aad = (orgId: string) => utf8Encode(`vault.trust.v1:${orgId}`)

export async function loadTrust(orgId: string, vaultKey: Uint8Array): Promise<TrustStore> {
  try {
    const { blob } = await api.orgs.getTrust(await session.token(), orgId)
    return blob ? await unsealJson<TrustStore>(vaultKey, blob, aad(orgId)) : {}
  } catch { return {} }
}

export async function saveTrust(orgId: string, vaultKey: Uint8Array, t: TrustStore): Promise<void> {
  await api.orgs.putTrust(await session.token(), orgId, await sealJson(vaultKey, t, aad(orgId))).catch(() => {})
}

/** The fingerprint for a pair of keys: both when there is a signing key. */
export async function fingerprintOf(publicKey: string, signingKey: string | null | undefined): Promise<string> {
  return signingKey ? fullFingerprint(fromBase64Url(publicKey), fromBase64Url(signingKey)) : identityFingerprint(fromBase64Url(publicKey))
}

/** Who may sign grants in this organization, as this account trusts them:
 *  user id → signing key. Also reports whether the owner's key changed since
 *  it was pinned. Pins the owner on first sight. */
export async function trustedSigners(orgId: string, members: OrgMember[], trust: TrustStore, vaultKey: Uint8Array): Promise<{ signers: Map<string, Uint8Array>; ownerChanged: boolean; trust: TrustStore }> {
  const signers = new Map<string, Uint8Array>()
  const owner = members.find((m) => m.role === 'owner')
  // The owner is the root of trust. Organizations made before signing keys
  // have no snapshot for it; its current key is pinned the first time.
  const ownerKey0 = owner?.signingPublicKey ?? owner?.currentSigningKey ?? null
  let t = trust
  if (ownerKey0 && !t.ownerSigningKey) {
    t = { ...t, ownerSigningKey: ownerKey0, ownerId: owner!.userId }
    await saveTrust(orgId, vaultKey, t)
  }
  const ownerChanged = !!(t.ownerSigningKey && owner && (owner.userId !== t.ownerId || ownerKey0 !== t.ownerSigningKey))
  if (!t.ownerSigningKey || ownerChanged) return { signers, ownerChanged, trust: t }
  const ownerKey = fromBase64Url(t.ownerSigningKey)
  signers.set(owner!.userId, ownerKey)
  for (const m of members) {
    if (m.role !== 'admin' || m.status !== 'confirmed' || !m.signingPublicKey || !m.endorsement) continue
    const fp = await fingerprintOf(m.publicKey, m.signingPublicKey)
    if (await verifyBytes(ownerKey, endorsementBytes(orgId, fp), m.endorsement)) signers.set(m.userId, fromBase64Url(m.signingPublicKey))
  }
  return { signers, ownerChanged, trust: t }
}

/** 'signed': verified · 'unsigned': from before signing, accepted for now ·
 *  'bad': refuse the key. */
export async function checkGrant(
  orgId: string, collectionId: string, version: number,
  access: { keyBlob: string; signature?: string; signedBy?: string },
  me: { publicKey: string; signingKey: string | null; userId?: string }, signers: Map<string, Uint8Array>, trust: TrustStore,
): Promise<'signed' | 'unsigned' | 'bad'> {
  if (!access.signature) return trust.requireSigned ? 'bad' : 'unsigned'
  // Its own signature this account trusts; otherwise the owner or an endorsed admin.
  const key = access.signedBy && access.signedBy === me.userId && me.signingKey ? fromBase64Url(me.signingKey)
    : access.signedBy ? signers.get(access.signedBy) : undefined
  // A signer not (yet) trusted, such as an admin the owner has still to
  // re-confirm, counts as unsigned: a forger gains nothing over a missing
  // signature, which is accepted only until the account has seen its grants
  // fully signed. A trusted signer's signature that fails is refused.
  if (!key) return trust.requireSigned ? 'bad' : 'unsigned'
  // The grant names its recipient by fingerprint: this account's, with or
  // without the signing key (an admin who confirmed it before signing keys).
  for (const recipient of new Set([await fingerprintOf(me.publicKey, me.signingKey), await fingerprintOf(me.publicKey, null)])) {
    if (await verifyGrant(key, { orgId, collectionId, version, recipient, keyBlob: access.keyBlob }, access.signature)) return 'signed'
  }
  return 'bad'
}
