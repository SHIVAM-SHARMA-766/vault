// Organizations and shared collections, decrypted in this browser
// (decisions/0009, 0015). The identity private key is unwrapped with the vault
// key when first needed and kept only in memory, like the vault key; it opens
// the org keys and collection keys sealed to this account, which open names
// and items. The server sees none of them.

import { useCallback, useEffect, useState } from 'react'

import {
  type EntryContent, fromBase64Url, generateCollectionKey, generateOrgKey, identityFingerprint, isWithinSizeLimit,
  openCollectionKey, openCollectionMeta, openOrgKey, openOrgMeta, openSharedItem, sealCollectionKey,
  sealCollectionMeta, sealOrgKey, sealOrgMeta, sealSharedItem, unwrapIdentityPrivateKey, wipe, openGroupMeta, sealGroupMeta,
} from '@vault/crypto'

import { type OrgInvitation, type OrgPolicies, type OrgRole, type SharePermission, api } from '../../lib/api.js'
import * as session from '../../lib/session.js'
import type { Decrypted } from '../vault/model.js'

export interface Identity { publicKey: Uint8Array; privateKey: Uint8Array; fingerprint: string }

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
  cached = { vaultKey, identity: { publicKey, privateKey, fingerprint: await identityFingerprint(publicKey) } }
  return cached.identity
}

export interface OrgView {
  id: string
  name: string
  role: OrgRole
  status: 'accepted' | 'confirmed'
  key?: Uint8Array
  policies: OrgPolicies
  /** Why this account cannot open the organization's collections, if it cannot. */
  policyGap: string | null
}

export interface CollectionView {
  orgId: string
  orgName: string
  id: string
  name: string
  keyVersion: number
  rotationNeeded: boolean
  key?: Uint8Array
  permission?: SharePermission
  hidePasswords: boolean
}

/** A shared item, in the same shape as a personal entry plus where it lives. */
export interface SharedEntry extends Decrypted {
  orgId: string
  collectionId: string
  permission: SharePermission
  hidePasswords: boolean
  /** Someone who could open this has left; its password should change (B9). */
  exposed?: boolean
}

export const canEdit = (p?: SharePermission) => p === 'edit' || p === 'manage'

export function useTeams(vaultKey: Uint8Array) {
  const [orgs, setOrgs] = useState<OrgView[]>([])
  const [collections, setCollections] = useState<CollectionView[]>([])
  const [shared, setShared] = useState<SharedEntry[]>([])
  const [invitations, setInvitations] = useState<OrgInvitation[]>([])
  const [identity, setIdentity] = useState<Identity | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const me = await myIdentity(vaultKey)
      setIdentity(me)
      const token = await session.token()
      const [{ orgs: rows }, { invitations: invs }] = await Promise.all([api.orgs.list(token), api.orgs.invitations(token)])
      setInvitations(invs)
      const views: OrgView[] = []
      const colls: CollectionView[] = []
      const entries: SharedEntry[] = []
      for (const row of rows) {
        const base = { id: row.id, role: row.role, status: row.status, policies: row.policies, policyGap: row.policyGap }
        if (row.status !== 'confirmed' || !row.orgKeyBlob) { views.push({ ...base, name: row.hint || 'Organization' }); continue }
        const key = await openOrgKey(me.privateKey, me.publicKey, row.orgKeyBlob, row.id)
        const name = (await openOrgMeta(row.id, row.nameBlob, key)).name
        views.push({ ...base, name, key })
        if (row.policyGap) continue
        const stale = new Set((await api.orgs.stale(token, row.id).catch(() => ({ items: [] }))).items.map((s) => `${s.collectionId}/${s.itemId}`))
        for (const c of (await api.orgs.collections(token, row.id)).collections) {
          const cname = (await openCollectionMeta(row.id, c.id, c.nameBlob, key).catch(() => ({ name: 'Unreadable collection' }))).name
          const view: CollectionView = { orgId: row.id, orgName: name, id: c.id, name: cname, keyVersion: c.keyVersion, rotationNeeded: c.rotationNeeded, hidePasswords: c.access?.hidePasswords ?? false }
          if (c.access && c.access.keyVersion === c.keyVersion) {
            view.key = await openCollectionKey(me.privateKey, me.publicKey, c.access.keyBlob, c.id, c.keyVersion)
            view.permission = c.access.permission
            for (const it of (await api.orgs.items(token, row.id, c.id)).items) {
              try {
                // `exposed` is the server's word (B9), never the blob's.
                const { exposed: _x, ...content } = (await openSharedItem(c.id, it.id, it.keyVersion, it.blob, view.key)) as EntryContent & { exposed?: unknown }
                entries.push({ ...content, id: it.id, updatedAt: it.updatedAt, orgId: row.id, collectionId: c.id, permission: view.permission, hidePasswords: view.hidePasswords, ...(stale.has(`${c.id}/${it.id}`) ? { exposed: true } : {}) })
              } catch { /* an item under an older key; rotation re-seals it */ }
            }
          }
          colls.push(view)
        }
      }
      entries.sort((a, b) => a.name.localeCompare(b.name))
      // The strictest idle policy among confirmed organizations sets the lock.
      const idle = rows.map((r) => (r.status === 'confirmed' ? r.policies.maxIdleMinutes : null)).filter((m): m is number => !!m)
      session.setIdleLimit(idle.length ? Math.min(...idle) : null)
      setOrgs(views); setCollections(colls); setShared(entries); setError('')
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

  async function createOrg(name: string, label: string): Promise<string> {
    const me = await myIdentity(vaultKey)
    const id = crypto.randomUUID()
    const key = generateOrgKey()
    await api.orgs.create(await session.token(), { id, hint: name.slice(0, 80), label, nameBlob: await sealOrgMeta(id, { name }, key), orgKeyBlob: await sealOrgKey(me.publicKey, key, id) })
    await load()
    return id
  }

  async function createCollection(orgId: string, name: string): Promise<string> {
    const me = await myIdentity(vaultKey)
    const org = orgs.find((o) => o.id === orgId)
    if (!org?.key) throw new Error('You cannot open that organization.')
    const id = crypto.randomUUID()
    const key = generateCollectionKey()
    await api.orgs.createCollection(await session.token(), orgId, {
      id, nameBlob: await sealCollectionMeta(orgId, id, { name }, org.key), keyBlob: await sealCollectionKey(me.publicKey, key, id, 1),
    })
    await load()
    return id
  }

  /** Confirms a member: the admin has compared fingerprints; seal the org key
   *  to the public key the server says the member accepted with. */
  async function confirm(orgId: string, userId: string, publicKey: string) {
    const org = orgs.find((o) => o.id === orgId)
    if (!org?.key) throw new Error('You cannot open that organization.')
    await api.orgs.confirm(await session.token(), orgId, userId, await sealOrgKey(fromBase64Url(publicKey), org.key, orgId))
  }

  async function grant(collectionId: string, userId: string, publicKey: string, permission: SharePermission, hidePasswords: boolean, viaGroup?: string) {
    const c = coll(collectionId)
    await api.orgs.grant(await session.token(), c.orgId, c.id, userId, {
      permission, hidePasswords, keyBlob: await sealCollectionKey(fromBase64Url(publicKey), c.key, c.id, c.keyVersion), ...(viaGroup ? { viaGroup } : {}),
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
  async function grantGroup(collectionId: string, groupId: string, permission: SharePermission, hidePasswords: boolean) {
    const c = coll(collectionId)
    const token = await session.token()
    const [{ groups }, { members }, { access }] = await Promise.all([api.orgs.groups(token, c.orgId), api.orgs.members(token, c.orgId), api.orgs.access(token, c.orgId, c.id)])
    const g = groups.find((x) => x.id === groupId)
    if (!g) throw new Error('That group is gone.')
    const grants = await Promise.all(g.members.filter((u) => !access.some((a) => a.userId === u)).map(async (u) => {
      const m = members.find((x) => x.userId === u)!
      return { userId: u, keyBlob: await sealCollectionKey(fromBase64Url(m.publicKey), c.key, c.id, c.keyVersion) }
    }))
    await api.orgs.grantGroup(token, c.orgId, c.id, groupId, { permission, hidePasswords, grants })
  }

  /** Adds a member to a group and seals the group's collections to them —
   *  those this admin can open; the rest wait for someone who can. */
  async function addToGroup(orgId: string, groupId: string, userId: string, publicKey: string): Promise<{ granted: number; skipped: number }> {
    const r = await api.orgs.addToGroup(await session.token(), orgId, groupId, userId)
    let granted = 0
    for (const gc of r.collections) {
      if (!collections.find((c) => c.id === gc.collectionId && c.permission === 'manage')) continue
      await grant(gc.collectionId, userId, publicKey, gc.permission, gc.hidePasswords, groupId)
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
      return { userId: a.userId, keyBlob: await sealCollectionKey(fromBase64Url(m.publicKey), key, c.id, version) }
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
    await api.orgs.rotate(token, c.orgId, c.id, { keyVersion: version, grants, items: resealed, drop })
    await load()
  }

  async function saveShared(collectionId: string, content: EntryContent, id?: string): Promise<string> {
    const c = coll(collectionId)
    const itemId = id ?? crypto.randomUUID()
    const { folderId: _f, exposed: _x, ...rest } = content as EntryContent & { exposed?: unknown }
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

  return { orgs, collections, shared, invitations, identity, error, load, createOrg, createCollection, confirm, grant, rotate, saveShared, deleteShared, createGroup, groupName, grantGroup, addToGroup }
}

export type Teams = ReturnType<typeof useTeams>
