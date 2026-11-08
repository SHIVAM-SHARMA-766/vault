// The organization recovery key (decisions/0026). The printed key R opens an
// escrowed ECDH private key; that key's public half is what the org key and
// every collection key are also sealed to. Holding R is therefore the only way
// to open those copies, and per-collection access stays as it is.

import { seal, unseal } from './aead.js'
import { toBase64Url, utf8Encode } from './encoding.js'
import { type IdentityKeyPair, generateIdentityKeyPair, openFromSender, sealForRecipient } from './identity.js'
import { buf, hkdfSha256, subtle } from './primitives.js'
import { randomBytes } from './random.js'

export const ORG_RECOVERY_KEY_BYTES = 32
const NO_SALT = new Uint8Array(32)

export interface OrgRecoveryDerived {
  /** Opens the escrowed private key. Never sent. */
  kek: Uint8Array
  /** Proves R to the server at recovery; its SHA-256 is the stored verifier. */
  auth: Uint8Array
}

export async function deriveOrgRecovery(recoveryKey: Uint8Array, orgId: string): Promise<OrgRecoveryDerived> {
  if (recoveryKey.length !== ORG_RECOVERY_KEY_BYTES) throw new Error('an organization recovery key is 32 bytes')
  const [kek, auth] = await Promise.all([
    hkdfSha256(recoveryKey, NO_SALT, utf8Encode(`vault.org-recovery.kek.v1:${orgId}`), 32),
    hkdfSha256(recoveryKey, NO_SALT, utf8Encode(`vault.org-recovery.auth.v1:${orgId}`), 32),
  ])
  return { kek, auth }
}

export async function recoveryVerifier(auth: Uint8Array): Promise<string> {
  return toBase64Url(new Uint8Array(await subtle().digest('SHA-256', buf(auth))))
}

const escrowAad = (orgId: string) => utf8Encode(`vault.org-recovery|${orgId}`)

export interface NewOrgRecovery {
  /** Shown once to the owner. */
  recoveryKey: Uint8Array
  pair: IdentityKeyPair
  /** What the server stores. */
  publicKey: string
  escrow: string
  verifier: string
}

export async function createOrgRecovery(orgId: string): Promise<NewOrgRecovery> {
  const recoveryKey = randomBytes(ORG_RECOVERY_KEY_BYTES)
  const pair = await generateIdentityKeyPair()
  const { kek, auth } = await deriveOrgRecovery(recoveryKey, orgId)
  return {
    recoveryKey, pair,
    publicKey: toBase64Url(pair.publicKey),
    escrow: await seal(kek, pair.privateKey, escrowAad(orgId)),
    verifier: await recoveryVerifier(auth),
  }
}

/** Opens the escrowed private key with the derived kek. */
export const openOrgRecoveryEscrow = (kek: Uint8Array, escrow: string, orgId: string) => unseal(kek, escrow, escrowAad(orgId))

const orgCtx = (orgId: string) => `org-key-recovery:${orgId}`
const collCtx = (collectionId: string, version: number) => `collection-key-recovery:${collectionId}:${version}`

export const sealOrgKeyForRecovery = (recoveryPublic: Uint8Array, orgKey: Uint8Array, orgId: string) => sealForRecipient(recoveryPublic, orgKey, orgCtx(orgId))
export const openOrgKeyFromRecovery = (recoveryPrivate: Uint8Array, recoveryPublic: Uint8Array, blob: string, orgId: string) => openFromSender(recoveryPrivate, recoveryPublic, blob, orgCtx(orgId))
export const sealCollectionKeyForRecovery = (recoveryPublic: Uint8Array, key: Uint8Array, collectionId: string, version: number) => sealForRecipient(recoveryPublic, key, collCtx(collectionId, version))
export const openCollectionKeyFromRecovery = (recoveryPrivate: Uint8Array, recoveryPublic: Uint8Array, blob: string, collectionId: string, version: number) =>
  openFromSender(recoveryPrivate, recoveryPublic, blob, collCtx(collectionId, version))
