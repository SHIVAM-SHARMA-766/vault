// Organizations and shared collections, decrypted in this browser
// (decisions/0009, 0015). The identity private key is unwrapped with the vault
// key when first needed and kept only in memory, like the vault key; it opens
// the org keys and collection keys sealed to this account, which open names
// and items. The server sees none of them.

import { useCallback, useEffect, useState } from 'react'

import {
  type EntryContent, endorsementBytes, signBytes, signGrant, unwrapSigningPrivateKey, verifyBytes, createOrgRecovery, deriveOrgRecovery, fromRecoveryString, openCollectionKeyFromRecovery, openOrgKeyFromRecovery, openOrgRecoveryEscrow, sealCollectionKeyForRecovery, sealOrgKeyForRecovery, toBase64Url, toRecoveryString, fromBase64Url, generateCollectionKey, generateOrgKey, isWithinSizeLimit,
  openCollectionKey, openCollectionMeta, openOrgKey, openOrgMeta, openSharedItem, sealCollectionKey,
  sealCollectionMeta, sealOrgKey, sealOrgMeta, sealSharedItem, unwrapIdentityPrivateKey, wipe, openGroupMeta, sealGroupMeta,
} from '@vault/crypto'

import { type OrgInvitation, type OrgMember, type OrgPolicies, type OrgRole, type SharePermission, api } from '../../lib/api.js'
import { checkGrant, fingerprintOf, loadTrust, saveTrust, trustedSigners } from './trust.js'
import * as session from '../../lib/session.js'
import { features } from '../../lib/instance.js'
import type { Decrypted } from '../vault/model.js'

export interface Identity {
  publicKey: Uint8Array
  privateKey: Uint8Array
  fingerprint: string
  /** The signing key pair (0025), once enrolled. */
  signingPublicKey?: Uint8Array
  signingPrivateKey?: Uint8Array
  /** base64url forms, as the server holds them. */
  publicKeyB64: string
  signingKeyB64: string | null
}

/** Forget the cached identity (after a signing key is enrolled). */
export function forgetIdentity(): void { if (cached) { wipe(cached.identity.privateKey); if (cached.identity.signingPrivateKey) wipe(cached.identity.signingPrivateKey) } cached = null }

let cached: { vaultKey: Uint8Array; identity: Identity } | null = null

// Locking forgets the private key with everything else.
session.subscribe((state) => {
  if (!state && cached) { wipe(cached.identity.privateKey); cached = null }
})

/** This account's identity key pair, unwrapped once per unlock. */
export async function myIdentity(vaultKey: Uint8Array): Promise<Identity> {
  if (cached && cached.vaultKey === vaultKey) return cached.identity
  const me = await api.me(await session.token())
  if (!me.identity) throw new Error('Your identity key is being created; unlock again in a moment.')
  const publicKey = fromBase64Url(me.identity.publicKey)
  const privateKey = await unwrapIdentityPrivateKey(me.identity.wrappedPrivateKey, vaultKey)
  const signing = me.identity.signingPublicKey && me.identity.wrappedSigningKey
    ? { signingPublicKey: fromBase64Url(me.identity.signingPublicKey), signingPrivateKey: await unwrapSigningPrivateKey(me.identity.wrappedSigningKey, vaultKey) }
    : {}
  cached = {
    vaultKey,
    identity: {
      publicKey, privateKey, ...signing,
      publicKeyB64: me.identity.publicKey, signingKeyB64: me.identity.signingPublicKey ?? null,
      fingerprint: await fingerprintOf(me.identity.publicKey, me.identity.signingPublicKey ?? null),
    },
  }
  return cached.identity
}

export interface OrgView {
  id: string
  name: string
  /** 'direct': a space between two people, made by "Share with a person" (D11). */
  kind: 'team' | 'direct'
  /** A guest's end date, and whether it has passed (decisions/0032, 2d). */
  until?: string
  ended?: boolean
  /** Suspended by the server's operator (hosted): nothing shared opens until it is resumed. */
  suspended?: boolean
  /** For a direct share, the other person's address (sealed in the org's name). */
  peer?: string
  /** The organization recovery key's public half, when one is set (0026). */
  recovery?: { createdAt: string; publicKey: string } | null
  role: OrgRole
  status: 'accepted' | 'confirmed'
  key?: Uint8Array
  policies: OrgPolicies
  /** Why this account cannot open the organization's collections, if it cannot. */
  policyGap: string | null
  /** The owner's signing key differs from the one this account pinned (0025). */
  ownerChanged?: boolean
}

export interface CollectionView {
  orgId: string
  orgName: string
  id: string
  name: string
  keyVersion: number
  rotationNeeded: boolean
  /** In a direct share with one person (D11). */
  direct?: boolean
  /** This version's key has a copy sealed to the recovery key (0026). */
  recoveryCovered?: boolean
  /** The grant's signature did not verify against a trusted admin (0025). */
  untrusted?: boolean
  /** The grant is from before signing (accepted until fully migrated). */
  unsigned?: boolean
  /** I asked for access and am waiting (D7). */
  requested?: boolean
  /** My access is a check-out that ends then (D7). */
  until?: string
  key?: Uint8Array
  permission?: SharePermission
  hidePasswords: boolean
  /** What this account's grant allows (2b): its set, and reveal, fill, export. */
  rights?: Rights
}

export interface Rights { set: string; reveal: boolean; fill: boolean; export: boolean }

/** The built-in set an older grant (level and hide-passwords) amounts to. */
export function legacySet(permission: SharePermission, hidePasswords: boolean): string {
  return permission === 'view' ? (hidePasswords ? 'use-only' : 'viewer') : permission === 'edit' ? 'editor' : 'manager'
}

/** A shared item, in the same shape as a personal entry plus where it lives. */
export interface SharedEntry extends Decrypted {
  orgId: string
  collectionId: string
  permission: SharePermission
  hidePasswords: boolean
  rights?: Rights
  /** Someone who could open this has left; its password should change (B9). */
  exposed?: boolean
  /** Admins are told when it is opened (D12). */
  sensitive?: boolean
}

export const canEdit = (p?: SharePermission) => p === 'edit' || p === 'manage'

export function useTeams(vaultKey: Uint8Array) {
  const [orgs, setOrgs] = useState<OrgView[]>([])
  const [collections, setCollections] = useState<CollectionView[]>([])
  const [shared, setShared] = useState<SharedEntry[]>([])
  const [invitations, setInvitations] = useState<OrgInvitation[]>([])
  const [identity, setIdentity] = useState<Identity | null>(null)
  const [error, setError] = useState('')
  /** True once the first load has finished, so screens do not flash what
   *  depends on it (an offer to create an organization, for one). */
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async () => {
    try {
      // A personal Vault has no organizations (decisions/0030).
      if (!(await features()).organizations) { setOrgs([]); setCollections([]); setShared([]); setInvitations([]); setError(''); setLoaded(true); return }
      const me = await myIdentity(vaultKey)
      setIdentity(me)
      const token = await session.token()
      const [{ orgs: rows }, { invitations: invs }] = await Promise.all([api.orgs.list(token), api.orgs.invitations(token)])
      setInvitations(invs)
      const views: OrgView[] = []
      const colls: CollectionView[] = []
      const entries: SharedEntry[] = []
      for (const row of rows) {
        const base = { id: row.id, kind: row.kind ?? 'team', recovery: row.recovery ?? null, role: row.role, status: row.status, policies: row.policies, policyGap: row.policyGap, ...(row.until ? { until: row.until } : {}), ...(row.ended ? { ended: true } : {}), ...(row.suspended ? { suspended: true } : {}) }
        // Suspended (hosted): its routes refuse, so nothing more to load.
        if (row.status !== 'confirmed' || !row.orgKeyBlob || row.suspended) { views.push({ ...base, name: row.hint || 'Organization' }); continue }
        const key = await openOrgKey(me.privateKey, me.publicKey, row.orgKeyBlob, row.id)
        const meta = await openOrgMeta(row.id, row.nameBlob, key)
        const name = meta.name
        views.push({ ...base, name, key, ...(meta.peer ? { peer: meta.peer } : {}) })
        if (row.policyGap) continue
        // Signed key grants (0025): who this account trusts to hand out keys here.
        const members = (await api.orgs.members(token, row.id).catch(() => ({ members: [] as OrgMember[] }))).members
        const ts = await trustedSigners(row.id, members, await loadTrust(row.id, vaultKey), vaultKey)
        if (ts.ownerChanged) views[views.length - 1]!.ownerChanged = true
        const statuses: string[] = []
        const stale = new Set((await api.orgs.stale(token, row.id).catch(() => ({ items: [] }))).items.map((s) => `${s.collectionId}/${s.itemId}`))
        for (const c of (await api.orgs.collections(token, row.id)).collections) {
          const cname = (await openCollectionMeta(row.id, c.id, c.nameBlob, key).catch(() => ({ name: 'Unreadable collection' }))).name
          const view: CollectionView = { ...(row.kind === 'direct' ? { direct: true } : {}), ...(c.requested ? { requested: true } : {}), ...(c.recoveryCovered ? { recoveryCovered: true } : {}), ...(c.access?.until ? { until: c.access.until } : {}), orgId: row.id, orgName: name, id: c.id, name: cname, keyVersion: c.keyVersion, rotationNeeded: c.rotationNeeded, hidePasswords: c.access?.hidePasswords ?? false, ...(c.access?.rights ? { rights: c.access.rights } : {}) }
          const status = c.access && c.access.keyVersion === c.keyVersion
            ? await checkGrant(row.id, c.id, c.keyVersion, c.access, { publicKey: me.publicKeyB64, signingKey: me.signingKeyB64, ...(session.get()?.userId ? { userId: session.get()!.userId } : {}) }, ts.signers, ts.trust)
            : null
          if (status) statuses.push(status)
          if (status === 'bad') view.untrusted = true
          if (status === 'unsigned') view.unsigned = true
          if (c.access && c.access.keyVersion === c.keyVersion && status !== 'bad') {
            view.key = await openCollectionKey(me.privateKey, me.publicKey, c.access.keyBlob, c.id, c.keyVersion)
            view.permission = c.access.permission
            for (const it of (await api.orgs.items(token, row.id, c.id)).items) {
              try {
                // `exposed` is the server's word (B9), never the blob's.
                const { exposed: _x, sensitive: _s, ...content } = (await openSharedItem(c.id, it.id, it.keyVersion, it.blob, view.key)) as EntryContent & { exposed?: unknown; sensitive?: unknown }
                entries.push({ ...content, id: it.id, updatedAt: it.updatedAt, orgId: row.id, collectionId: c.id, permission: view.permission, hidePasswords: view.hidePasswords, ...(view.rights ? { rights: view.rights } : {}), ...(stale.has(`${c.id}/${it.id}`) ? { exposed: true } : {}), ...(it.sensitive ? { sensitive: true } : {}) })
              } catch { /* an item under an older key; rotation re-seals it */ }
            }
          }
          colls.push(view)
        }
        // Every grant here verified: from now on refuse unsigned ones (0025).
        if (statuses.length && statuses.every((x) => x === 'signed') && !ts.trust.requireSigned && !ts.ownerChanged) {
          void saveTrust(row.id, vaultKey, { ...ts.trust, requireSigned: true })
        }
        // An owner endorses its admins' keys; a manager re-signs old grants.
        if (me.signingPrivateKey) void upkeep(row.id, row.role, members, colls.filter((x) => x.orgId === row.id), me)
      }
      // Collections this account manages that lack a recovery copy get one
      // now (0026), so a recovery key created before them still covers them.
      for (const c of colls) {
        const rec = views.find((o) => o.id === c.orgId)?.recovery
        if (!rec || !c.key || c.permission !== 'manage' || c.recoveryCovered) continue
        void sealCollectionKeyForRecovery(fromBase64Url(rec.publicKey), c.key, c.id, c.keyVersion)
          .then((blob) => api.orgs.setCollectionRecovery(token, c.orgId, c.id, c.keyVersion, blob)).catch(() => { /* next time */ })
      }
      entries.sort((a, b) => a.name.localeCompare(b.name))
      // The strictest idle policy among confirmed organizations sets the lock.
      const idle = rows.map((r) => (r.status === 'confirmed' ? r.policies.maxIdleMinutes : null)).filter((m): m is number => !!m)
      session.setIdleLimit(idle.length ? Math.min(...idle) : null)
      setOrgs(views); setCollections(colls); setShared(entries); setError(''); setLoaded(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load organizations.')
    }
  }, [vaultKey])

  useEffect(() => { void load() }, [load])

  const coll = (id: string) => {
    const c = collections.find((x) => x.id === id)
    if (!c?.key) throw new Error('You cannot open that collection.')
    return c as CollectionView & { key: Uint8Array }
  }

  /** A signature over a grant to `recipient` (0025), when this account can sign. */
  async function signFor(orgId: string, collectionId: string, version: number, recipientPublicKey: string, recipientSigningKey: string | null | undefined, keyBlob: string): Promise<{ signature?: string }> {
    const me = await myIdentity(vaultKey)
    if (!me.signingPrivateKey) return {}
    const recipient = await fingerprintOf(recipientPublicKey, recipientSigningKey ?? null)
    return { signature: await signGrant(me.signingPrivateKey, { orgId, collectionId, version, recipient, keyBlob }) }
  }

  /** Background upkeep after a load: the owner endorses admins whose keys it
   *  confirmed; a manager re-seals and signs grants made before signing. */
  async function upkeep(orgId: string, role: string, members: OrgMember[], colls: CollectionView[], me: Identity) {
    try {
      const token = await session.token()
      if (role === 'owner') {
        for (const m of members) {
          if (m.role !== 'admin' || m.status !== 'confirmed' || !m.signingPublicKey) continue
          const bytes = endorsementBytes(orgId, await fingerprintOf(m.publicKey, m.signingPublicKey))
          if (m.endorsement && me.signingPublicKey && await verifyBytes(me.signingPublicKey, bytes, m.endorsement)) continue
          await api.orgs.endorse(token, orgId, m.userId, await signBytes(me.signingPrivateKey!, bytes))
        }
      }
      for (const c of colls) {
        if (!c.key || c.permission !== 'manage') continue
        const { access } = await api.orgs.access(token, orgId, c.id)
        for (const a of access as { userId: string; permission: SharePermission; hidePasswords: boolean; set?: string; signed?: boolean; viaGroup?: string | null }[]) {
          if (a.signed) continue
          const m = members.find((x) => x.userId === a.userId)
          if (!m || m.status !== 'confirmed') continue
          const keyBlob = await sealCollectionKey(fromBase64Url(m.publicKey), c.key, c.id, c.keyVersion)
          await api.orgs.grant(token, orgId, c.id, m.userId, { set: a.set ?? legacySet(a.permission, a.hidePasswords), keyBlob, ...(a.viaGroup ? { viaGroup: a.viaGroup } : {}), ...(await signFor(orgId, c.id, c.keyVersion, m.publicKey, m.signingPublicKey, keyBlob)) })
        }
      }
    } catch { /* tried again at the next load */ }
  }

  /** Creates an organization, and its recovery key (0026): returned once, as
   *  text, for the owner to keep offline. */
  async function createOrg(name: string, label: string): Promise<{ id: string; recoveryKey: string }> {
    const me = await myIdentity(vaultKey)
    const id = crypto.randomUUID()
    const key = generateOrgKey()
    const token = await session.token()
    await api.orgs.create(token, { id, hint: name.slice(0, 80), label, nameBlob: await sealOrgMeta(id, { name }, key), orgKeyBlob: await sealOrgKey(me.publicKey, key, id) })
    const rec = await createOrgRecovery(id)
    await api.orgs.setRecovery(token, id, { publicKey: rec.publicKey, escrow: rec.escrow, verifier: rec.verifier, orgKeyRecovery: await sealOrgKeyForRecovery(rec.pair.publicKey, key, id), collections: [] })
    await load()
    return { id, recoveryKey: toRecoveryString(rec.recoveryKey) }
  }

  /** Creates or replaces an organization's recovery key, sealing the org key
   *  and every collection key this account can open to it. */
  async function makeRecoveryKey(orgId: string): Promise<{ recoveryKey: string; covered: number; total: number }> {
    const org = orgs.find((o) => o.id === orgId)
    if (!org?.key) throw new Error('You cannot open that organization.')
    const rec = await createOrgRecovery(orgId)
    const colls = collections.filter((c) => c.orgId === orgId)
    const open = colls.filter((c) => c.key)
    await api.orgs.setRecovery(await session.token(), orgId, {
      publicKey: rec.publicKey, escrow: rec.escrow, verifier: rec.verifier,
      orgKeyRecovery: await sealOrgKeyForRecovery(rec.pair.publicKey, org.key, orgId),
      collections: await Promise.all(open.map(async (c) => ({ id: c.id, recoveryBlob: await sealCollectionKeyForRecovery(rec.pair.publicKey, c.key!, c.id, c.keyVersion) }))),
    })
    await load()
    return { recoveryKey: toRecoveryString(rec.recoveryKey), covered: open.length, total: colls.length }
  }

  /** Recovers an organization with its recovery key: opens the escrow here,
   *  re-seals the org key and every recoverable collection key to this
   *  account, and asks the server to make it the owner. */
  async function recoverWithKey(orgId: string, recoveryText: string): Promise<{ restored: number; total: number }> {
    const me = await myIdentity(vaultKey)
    const token = await session.token()
    const r = await api.orgs.getRecovery(token, orgId)
    let raw: Uint8Array
    try { raw = fromRecoveryString(recoveryText) } catch { throw new Error('That is not this organization\'s recovery key.') }
    if (raw.length !== 32) throw new Error('That is not this organization\'s recovery key.')
    const { kek, auth } = await deriveOrgRecovery(raw, orgId)
    let priv: Uint8Array
    try { priv = await openOrgRecoveryEscrow(kek, r.escrow, orgId) } catch { throw new Error('That is not this organization\'s recovery key.') }
    const pub = fromBase64Url(r.publicKey)
    try {
      const orgKey = await openOrgKeyFromRecovery(priv, pub, r.orgKeyRecovery, orgId)
      const grants = []
      for (const c of r.collections) {
        if (!c.recoveryBlob) continue
        try {
          const key = await openCollectionKeyFromRecovery(priv, pub, c.recoveryBlob, c.id, c.keyVersion)
          const keyBlob = await sealCollectionKey(me.publicKey, key, c.id, c.keyVersion)
          grants.push({ collectionId: c.id, keyVersion: c.keyVersion, keyBlob, ...(await signFor(orgId, c.id, c.keyVersion, me.publicKeyB64, me.signingKeyB64, keyBlob)) })
        } catch { /* a copy from an older key: skipped */ }
      }
      const res = await api.orgs.recover(token, orgId, { auth: toBase64Url(auth), orgKeyBlob: await sealOrgKey(me.publicKey, orgKey, orgId), grants })
      await load()
      return { restored: res.restored, total: r.collections.length }
    } finally { wipe(priv) }
  }

  async function createCollection(orgId: string, name: string): Promise<string> {
    const me = await myIdentity(vaultKey)
    const org = orgs.find((o) => o.id === orgId)
    if (!org?.key) throw new Error('You cannot open that organization.')
    const id = crypto.randomUUID()
    const key = generateCollectionKey()
    const recoveryPub = org.recovery?.publicKey ? fromBase64Url(org.recovery.publicKey) : null
    const selfBlob = await sealCollectionKey(me.publicKey, key, id, 1)
    await api.orgs.createCollection(await session.token(), orgId, {
      id, nameBlob: await sealCollectionMeta(orgId, id, { name }, org.key), keyBlob: selfBlob, ...(await signFor(orgId, id, 1, me.publicKeyB64, me.signingKeyB64, selfBlob)),
      ...(recoveryPub ? { recoveryBlob: await sealCollectionKeyForRecovery(recoveryPub, key, id, 1) } : {}),
    })
    await load()
    return id
  }

  /** Shares one item with one person (D11). The first time, a direct space
   *  is made for the two of you (an organization of two, with one collection),
   *  they are invited, and the item is sealed into it at once; they can open it
   *  after accepting and after you confirm their fingerprint. Later items to
   *  the same person go into the same space. */
  async function shareWithPerson(email: string, content: EntryContent): Promise<{ itemId: string; collectionId: string; waiting: boolean }> {
    const address = email.trim().toLowerCase()
    const token = await session.token()
    const existing = orgs.find((o) => o.kind === 'direct' && o.peer === address && o.key)
    const { folderId: _f, exposed: _x, ...rest } = content as EntryContent & { exposed?: unknown }
    if (existing) {
      const c = collections.find((x) => x.orgId === existing.id && x.key)
      if (!c) throw new Error('That shared space has no collection you can open.')
      const itemId = await saveShared(c.id, rest)
      const { members } = await api.orgs.members(token, existing.id)
      return { itemId, collectionId: c.id, waiting: !members.some((m) => m.status === 'confirmed' && m.role !== 'owner') }
    }
    const me = await myIdentity(vaultKey)
    const orgId = crypto.randomUUID()
    const orgKey = generateOrgKey()
    const who = address.split('@')[0]!
    const mine = (session.get()?.email ?? '').split('@')[0] || 'Me'
    // Named for both of you, so it reads the same from either side.
    const both = `${mine} & ${who}`.slice(0, 80)
    await api.orgs.create(token, { id: orgId, kind: 'direct', hint: both, label: mine, nameBlob: await sealOrgMeta(orgId, { name: both, peer: address }, orgKey), orgKeyBlob: await sealOrgKey(me.publicKey, orgKey, orgId) })
    const collId = crypto.randomUUID()
    const collKey = generateCollectionKey()
    const selfBlob = await sealCollectionKey(me.publicKey, collKey, collId, 1)
    await api.orgs.createCollection(token, orgId, { id: collId, nameBlob: await sealCollectionMeta(orgId, collId, { name: both }, orgKey), keyBlob: selfBlob, ...(await signFor(orgId, collId, 1, me.publicKeyB64, me.signingKeyB64, selfBlob)) })
    await api.orgs.invite(token, orgId, address, who, 'member')
    const itemId = crypto.randomUUID()
    const blob = await sealSharedItem(collId, itemId, 1, rest, collKey)
    if (!isWithinSizeLimit(blob)) throw new Error('That item is too large to store.')
    await api.orgs.putItem(token, orgId, collId, itemId, blob, 1)
    await load()
    return { itemId, collectionId: collId, waiting: true }
  }

  /** After confirming the other person in a direct share, they get its
   *  collection at once — that is the point of it. */
  async function grantDirect(orgId: string, userId: string, publicKey: string) {
    const org = orgs.find((o) => o.id === orgId)
    if (org?.kind !== 'direct') return
    for (const c of collections.filter((x) => x.orgId === orgId && x.key && x.permission === 'manage')) {
      await grant(c.id, userId, publicKey, 'editor')
    }
  }

  /** Confirms a member: the admin has compared fingerprints; seal the org key
   *  to the public key the server says the member accepted with. */
  async function confirm(orgId: string, userId: string, publicKey: string) {
    const org = orgs.find((o) => o.id === orgId)
    if (!org?.key) throw new Error('You cannot open that organization.')
    await api.orgs.confirm(await session.token(), orgId, userId, await sealOrgKey(fromBase64Url(publicKey), org.key, orgId))
  }

  /** Gives a member a collection, with a permission set (decisions/0032, 2b). */
  async function grant(collectionId: string, userId: string, publicKey: string, set: string, viaGroup?: string, hours?: number) {
    const c = coll(collectionId)
    const token = await session.token()
    const m = (await api.orgs.members(token, c.orgId)).members.find((x) => x.userId === userId)
    const keyBlob = await sealCollectionKey(fromBase64Url(publicKey), c.key, c.id, c.keyVersion)
    await api.orgs.grant(token, c.orgId, c.id, userId, {
      set, keyBlob, ...(viaGroup ? { viaGroup } : {}), ...(hours ? { hours } : {}),
      ...(await signFor(c.orgId, c.id, c.keyVersion, publicKey, m?.signingPublicKey, keyBlob)),
    })
  }

  async function createGroup(orgId: string, name: string) {
    const org = orgs.find((o) => o.id === orgId)
    if (!org?.key) throw new Error('You cannot open that organization.')
    const id = crypto.randomUUID()
    await api.orgs.createGroup(await session.token(), orgId, id, await sealGroupMeta(orgId, id, { name }, org.key))
  }

  async function groupName(orgId: string, groupId: string, blob: string): Promise<string> {
    const org = orgs.find((o) => o.id === orgId)
    if (!org?.key) return 'Group'
    return (await openGroupMeta(orgId, groupId, blob, org.key).catch(() => ({ name: 'Unreadable group' }))).name
  }

  /** Grants a collection to a group: the key sealed to each member who lacks it. */
  async function grantGroup(collectionId: string, groupId: string, set: string) {
    const c = coll(collectionId)
    const token = await session.token()
    const [{ groups }, { members }, { access }] = await Promise.all([api.orgs.groups(token, c.orgId), api.orgs.members(token, c.orgId), api.orgs.access(token, c.orgId, c.id)])
    const g = groups.find((x) => x.id === groupId)
    if (!g) throw new Error('That group is gone.')
    const grants = await Promise.all(g.members.filter((u) => !access.some((a) => a.userId === u)).map(async (u) => {
      const m = members.find((x) => x.userId === u)!
      const keyBlob = await sealCollectionKey(fromBase64Url(m.publicKey), c.key, c.id, c.keyVersion)
      return { userId: u, keyBlob, ...(await signFor(c.orgId, c.id, c.keyVersion, m.publicKey, m.signingPublicKey, keyBlob)) }
    }))
    await api.orgs.grantGroup(token, c.orgId, c.id, groupId, { set, grants })
  }

  /** Adds a member to a group and seals the group's collections to them —
   *  those this admin can open; the rest wait for someone who can. */
  async function addToGroup(orgId: string, groupId: string, userId: string, publicKey: string): Promise<{ granted: number; skipped: number }> {
    const r = await api.orgs.addToGroup(await session.token(), orgId, groupId, userId)
    let granted = 0
    for (const gc of r.collections) {
      if (!collections.find((c) => c.id === gc.collectionId && c.permission === 'manage')) continue
      await grant(gc.collectionId, userId, publicKey, gc.set ?? legacySet(gc.permission, gc.hidePasswords), groupId)
      granted++
    }
    return { granted, skipped: r.collections.length - granted }
  }

  /** Re-keys a collection: a new key version, every item re-encrypted under
   *  it, sealed to every member who still has access (decisions/0015). */
  async function rotate(collectionId: string) {
    const c = coll(collectionId)
    const token = await session.token()
    const [{ access }, { members }, { items }] = await Promise.all([
      api.orgs.access(token, c.orgId, c.id), api.orgs.members(token, c.orgId), api.orgs.items(token, c.orgId, c.id),
    ])
    const version = c.keyVersion + 1
    const key = generateCollectionKey()
    const grants = await Promise.all(access.map(async (a) => {
      const m = members.find((x) => x.userId === a.userId)
      if (!m) throw new Error('A member with access has left; reload and try again.')
      const keyBlob = await sealCollectionKey(fromBase64Url(m.publicKey), key, c.id, version)
      return { userId: a.userId, keyBlob, ...(await signFor(c.orgId, c.id, version, m.publicKey, m.signingPublicKey, keyBlob)) }
    }))
    // An item this member cannot decrypt (planted by someone holding an old
    // key, or damaged) is dropped rather than allowed to block the rotation.
    const resealed: { id: string; blob: string }[] = []
    const drop: string[] = []
    for (const it of items) {
      try {
        const content = await openSharedItem(c.id, it.id, it.keyVersion, it.blob, c.key)
        resealed.push({ id: it.id, blob: await sealSharedItem(c.id, it.id, version, content, key) })
      } catch { drop.push(it.id) }
    }
    const recoveryPub = orgs.find((o) => o.id === c.orgId)?.recovery?.publicKey
    await api.orgs.rotate(token, c.orgId, c.id, { keyVersion: version, grants, items: resealed, drop, ...(recoveryPub ? { recoveryBlob: await sealCollectionKeyForRecovery(fromBase64Url(recoveryPub), key, c.id, version) } : {}) })
    await load()
  }

  async function saveShared(collectionId: string, content: EntryContent, id?: string): Promise<string> {
    const c = coll(collectionId)
    const itemId = id ?? crypto.randomUUID()
    const { folderId: _f, exposed: _x, sensitive: _s, ...rest } = content as EntryContent & { exposed?: unknown; sensitive?: unknown }
    const blob = await sealSharedItem(c.id, itemId, c.keyVersion, rest, c.key)
    if (!isWithinSizeLimit(blob)) throw new Error('That item is too large to store.')
    // A new password clears the "someone who left could have seen it" mark (B9).
    const previous = id ? shared.find((e) => e.id === id) : undefined
    const passwordChanged = !!previous && (previous.password ?? '') !== (content.password ?? '') && !!content.password
    await api.orgs.putItem(await session.token(), c.orgId, c.id, itemId, blob, c.keyVersion, passwordChanged)
    await load()
    return itemId
  }

  async function deleteShared(collectionId: string, id: string) {
    const c = coll(collectionId)
    await api.orgs.deleteItem(await session.token(), c.orgId, c.id, id)
    await load()
  }

  return { loaded, orgs, collections, shared, invitations, identity, error, load, shareWithPerson, grantDirect, createOrg, makeRecoveryKey, recoverWithKey, createCollection, confirm, grant, rotate, saveShared, deleteShared, createGroup, groupName, grantGroup, addToGroup }
}

export type Teams = ReturnType<typeof useTeams>
