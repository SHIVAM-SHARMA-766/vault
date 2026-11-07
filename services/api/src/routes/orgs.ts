// Organizations, collections and shared items (decisions/0009, 0015).
//
// The server stores and serves sealed keys; it never holds one it can open.
//
//   member lifecycle   invited (by address digest) → accepted → confirmed
//                      Only a confirmed member is ever given the org key or a
//                      collection key, and confirming is an admin comparing the
//                      member's key fingerprint out of band (threat A11).
//   org roles          owner · admin · member
//   collection access  view · edit · manage, and a "hide passwords" policy —
//                      enforced here on what is served and accepted; the
//                      cryptography decides who *can* decrypt.
//
// An invitation is stored against the invitee's address digest, so inviting
// answers the same whether or not the address has an account (threat A7), and
// the invitation appears when that person signs in.

import type { App } from '../context.js'
import { HttpError, type LambdaEvent, type LambdaResponse, badRequest, conflict, forbidden, json, notFound, parseJsonBody } from '../http.js'
import { emailDigest } from '../identity.js'
import {
  COLLECTION_PREFIX, ITEM_PREFIX, ORG_INVITE_PREFIX, ORG_MEMBER_PREFIX, ORG_META_SK, ORG_PENDING_PREFIX, PROFILE_SK, USER_ORG_PREFIX,
  accessPrefix, accessSk, collectionItemsPk, collectionSk, emailPk, isValidId, itemSk, orgInviteSk, orgMemberSk, orgPendingSk,
  orgPk, userOrgSk, userPk,
} from '../keys.js'
import { AlreadyExists, type Item } from '../store.js'
import { requireEmail, requireSealed, requireSharedKey } from '../validate.js'

export type OrgRole = 'owner' | 'admin' | 'member'
export type Permission = 'view' | 'edit' | 'manage'
const PERMISSIONS: readonly Permission[] = ['view', 'edit', 'manage']
const RANK: Record<Permission, number> = { view: 1, edit: 2, manage: 3 }
const MAX_LABEL = 80
const MAX_HINT = 80

interface Member extends Item {
  userId: string
  role: OrgRole
  status: 'accepted' | 'confirmed'
  label: string
  /** The public key as it was when the member accepted. What an admin
   *  confirms, and what keys are sealed to; never updated silently. */
  publicKey: string
  orgKeyBlob?: string
  joinedAt: string
  confirmedAt?: string
}

interface Access extends Item {
  collectionId: string
  userId: string
  keyBlob: string
  keyVersion: number
  permission: Permission
  hidePasswords: boolean
}

interface Collection extends Item {
  id: string
  nameBlob: string
  keyVersion: number
  /** Set when someone lost access: the key should be rotated (step 4). */
  rotationNeeded?: boolean
  createdAt: string
}

const now = (app: App) => new Date(app.now()).toISOString()
const body = (event: LambdaEvent) => parseJsonBody<Record<string, unknown>>(event)
const label = (v: unknown, field = 'label') => {
  if (v === undefined || v === null) return ''
  if (typeof v !== 'string' || v.trim().length > MAX_LABEL) throw badRequest(`${field} is at most ${MAX_LABEL} characters.`)
  return v.trim()
}
const id = (v: unknown, field: string) => {
  if (!isValidId(v)) throw badRequest(`${field} must be an identifier.`)
  return v
}

async function member(app: App, orgId: string, userId: string): Promise<Member | null> {
  return (await app.store.get(orgPk(orgId), orgMemberSk(userId))) as Member | null
}

/** The caller as a member of the organization, or a 404 for anyone else —
 *  an organization you do not belong to is indistinguishable from none. */
async function requireMember(app: App, orgId: string, userId: string, opts: { confirmed?: boolean; admin?: boolean; owner?: boolean } = {}): Promise<Member> {
  if (!isValidId(orgId)) throw notFound()
  const m = await member(app, orgId, userId)
  if (!m) throw notFound()
  if ((opts.confirmed || opts.admin || opts.owner) && m.status !== 'confirmed') throw forbidden()
  if (opts.admin && m.role === 'member') throw forbidden()
  if (opts.owner && m.role !== 'owner') throw forbidden()
  return m
}

async function access(app: App, orgId: string, collectionId: string, userId: string): Promise<Access | null> {
  return (await app.store.get(orgPk(orgId), accessSk(collectionId, userId))) as Access | null
}

async function requireAccess(app: App, orgId: string, collectionId: string, userId: string, at: Permission): Promise<{ m: Member; a: Access; c: Collection }> {
  const m = await requireMember(app, orgId, userId, { confirmed: true })
  if (!isValidId(collectionId)) throw notFound()
  const c = (await app.store.get(orgPk(orgId), collectionSk(collectionId))) as Collection | null
  if (!c) throw notFound()
  const a = await access(app, orgId, collectionId, userId)
  if (!a) throw notFound()
  if (RANK[a.permission] < RANK[at]) throw forbidden()
  return { m, a, c }
}

async function publicKeyOf(app: App, userId: string): Promise<string> {
  const profile = await app.store.get(userPk(userId), PROFILE_SK)
  const pk = profile?.['publicKey']
  if (typeof pk !== 'string') throw new HttpError(409, 'conflict', 'This account has no identity key yet; it is created on the next unlock.')
  return pk
}

// ── Organizations ─────────────────────────────────────────────────────────

export async function createOrg(app: App, userId: string, event: LambdaEvent): Promise<LambdaResponse> {
  const b = body(event)
  const orgId = id(b['id'], 'id')
  const nameBlob = requireSealed(b['nameBlob'], 'nameBlob', 4096)
  const orgKeyBlob = requireSharedKey(b['orgKeyBlob'], 'orgKeyBlob')
  const hint = label(b['hint'], 'hint').slice(0, MAX_HINT)
  const publicKey = await publicKeyOf(app, userId)
  const at = now(app)
  try {
    await app.store.put({ pk: orgPk(orgId), sk: ORG_META_SK, id: orgId, nameBlob, hint, createdAt: at, createdBy: userId }, { mustNotExist: true })
  } catch (err) {
    if (err instanceof AlreadyExists) throw conflict('An organization with that id exists.')
    throw err
  }
  const owner: Member = { pk: orgPk(orgId), sk: orgMemberSk(userId), userId, role: 'owner', status: 'confirmed', label: label(b['label']) || 'Owner', publicKey, orgKeyBlob, joinedAt: at, confirmedAt: at }
  await app.store.put(owner)
  await app.store.put({ pk: userPk(userId), sk: userOrgSk(orgId), orgId })
  return json(201, { id: orgId })
}

export async function myOrgs(app: App, userId: string): Promise<LambdaResponse> {
  const pointers = await app.store.query(userPk(userId), USER_ORG_PREFIX)
  const orgs = []
  for (const p of pointers) {
    const orgId = String(p['orgId'])
    const [meta, m] = await Promise.all([app.store.get(orgPk(orgId), ORG_META_SK), member(app, orgId, userId)])
    if (!meta || !m) continue
    orgs.push({ id: orgId, nameBlob: meta['nameBlob'], hint: meta['hint'] ?? '', role: m.role, status: m.status, ...(m.orgKeyBlob ? { orgKeyBlob: m.orgKeyBlob } : {}) })
  }
  return json(200, { orgs })
}

export async function deleteOrg(app: App, userId: string, orgId: string): Promise<LambdaResponse> {
  await requireMember(app, orgId, userId, { owner: true })
  for (const c of await app.store.query(orgPk(orgId), COLLECTION_PREFIX)) {
    for (const i of await app.store.query(collectionItemsPk(String(c['id'])))) await app.store.delete(i.pk, i.sk)
  }
  for (const row of await app.store.query(orgPk(orgId))) {
    if (row.sk.startsWith(ORG_MEMBER_PREFIX)) await app.store.delete(userPk(String(row['userId'])), userOrgSk(orgId))
    if (row.sk.startsWith(ORG_PENDING_PREFIX)) await app.store.delete(emailPk(row.sk.slice(ORG_PENDING_PREFIX.length)), orgInviteSk(orgId))
    await app.store.delete(row.pk, row.sk)
  }
  return json(200, { ok: true })
}

// ── Invitations and membership ────────────────────────────────────────────

export async function invite(app: App, userId: string, event: LambdaEvent, orgId: string): Promise<LambdaResponse> {
  const me = await requireMember(app, orgId, userId, { admin: true })
  const b = body(event)
  const email = requireEmail(b['email'])
  const role: OrgRole = b['role'] === 'admin' ? 'admin' : 'member'
  if (role === 'admin' && me.role !== 'owner') throw forbidden()
  const memberLabel = label(b['label']) || email.split('@')[0]!
  const digest = emailDigest(email, app.config.pepper)
  const meta = await app.store.get(orgPk(orgId), ORG_META_SK)
  const at = now(app)
  // Both rows are written whether or not the address has an account: the
  // response is the same, and the invitation waits for them to sign in.
  await app.store.put({ pk: orgPk(orgId), sk: orgPendingSk(digest), digest, role, label: memberLabel, invitedBy: userId, invitedAt: at })
  await app.store.put({ pk: emailPk(digest), sk: orgInviteSk(orgId), orgId, role, label: memberLabel, hint: meta?.['hint'] ?? '', invitedAt: at })
  return json(201, { ok: true })
}

export async function withdrawInvite(app: App, userId: string, orgId: string, digest: string): Promise<LambdaResponse> {
  await requireMember(app, orgId, userId, { admin: true })
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(digest)) throw notFound()
  await app.store.delete(orgPk(orgId), orgPendingSk(digest))
  await app.store.delete(emailPk(digest), orgInviteSk(orgId))
  return json(200, { ok: true })
}

async function digestOf(app: App, userId: string): Promise<string> {
  const profile = await app.store.get(userPk(userId), PROFILE_SK)
  if (!profile) throw notFound()
  return String(profile['emailDigest'])
}

export async function myInvitations(app: App, userId: string): Promise<LambdaResponse> {
  const rows = await app.store.query(emailPk(await digestOf(app, userId)), ORG_INVITE_PREFIX)
  return json(200, { invitations: rows.map((r) => ({ orgId: r['orgId'], hint: r['hint'] ?? '', role: r['role'], invitedAt: r['invitedAt'] })) })
}

export async function acceptInvite(app: App, userId: string, orgId: string): Promise<LambdaResponse> {
  if (!isValidId(orgId)) throw notFound()
  const digest = await digestOf(app, userId)
  const inv = await app.store.get(emailPk(digest), orgInviteSk(orgId))
  if (!inv) throw notFound()
  const publicKey = await publicKeyOf(app, userId)
  const m: Member = { pk: orgPk(orgId), sk: orgMemberSk(userId), userId, role: inv['role'] === 'admin' ? 'admin' : 'member', status: 'accepted', label: String(inv['label'] ?? 'Member'), publicKey, joinedAt: now(app) }
  try {
    await app.store.put(m, { mustNotExist: true })
  } catch (err) {
    if (!(err instanceof AlreadyExists)) throw err
  }
  await app.store.put({ pk: userPk(userId), sk: userOrgSk(orgId), orgId })
  await app.store.delete(emailPk(digest), orgInviteSk(orgId))
  await app.store.delete(orgPk(orgId), orgPendingSk(digest))
  return json(200, { ok: true, status: 'accepted' })
}

export async function declineInvite(app: App, userId: string, orgId: string): Promise<LambdaResponse> {
  if (!isValidId(orgId)) throw notFound()
  const digest = await digestOf(app, userId)
  await app.store.delete(emailPk(digest), orgInviteSk(orgId))
  await app.store.delete(orgPk(orgId), orgPendingSk(digest))
  return json(200, { ok: true })
}

/** Members and pending invitations. Public keys are included so an admin's
 *  client can show fingerprints and seal keys to confirmed members. */
export async function members(app: App, userId: string, orgId: string): Promise<LambdaResponse> {
  const me = await requireMember(app, orgId, userId, { confirmed: true })
  const rows = await app.store.query(orgPk(orgId))
  const list = (rows.filter((r) => r.sk.startsWith(ORG_MEMBER_PREFIX)) as Member[]).map((m) => ({
    userId: m.userId, role: m.role, status: m.status, label: m.label, publicKey: m.publicKey, joinedAt: m.joinedAt, confirmedAt: m.confirmedAt ?? null,
  }))
  const pending = me.role === 'member' ? [] : rows.filter((r) => r.sk.startsWith(ORG_PENDING_PREFIX))
    .map((r) => ({ id: r['digest'], label: r['label'], role: r['role'], invitedAt: r['invitedAt'] }))
  return json(200, { members: list, pending })
}

/** An admin confirms a member after comparing fingerprints, by sending the
 *  org key sealed to the public key that member accepted with. */
export async function confirmMember(app: App, userId: string, event: LambdaEvent, orgId: string, target: string): Promise<LambdaResponse> {
  await requireMember(app, orgId, userId, { admin: true })
  const m = await member(app, orgId, target)
  if (!m) throw notFound()
  if (m.status === 'confirmed') throw conflict('Already confirmed.')
  const orgKeyBlob = requireSharedKey(body(event)['orgKeyBlob'], 'orgKeyBlob')
  // If the account's key changed since it accepted, the admin confirmed a
  // fingerprint that is no longer current. Refuse rather than seal to it.
  if ((await publicKeyOf(app, target)) !== m.publicKey) throw conflict('This member\'s identity key changed after they accepted. Remove them and invite again.')
  await app.store.put({ ...m, status: 'confirmed', orgKeyBlob, confirmedAt: now(app) })
  return json(200, { ok: true })
}

export async function setMemberRole(app: App, userId: string, event: LambdaEvent, orgId: string, target: string): Promise<LambdaResponse> {
  await requireMember(app, orgId, userId, { owner: true })
  const role = body(event)['role']
  if (role !== 'admin' && role !== 'member') throw badRequest('role must be admin or member.')
  const m = await member(app, orgId, target)
  if (!m) throw notFound()
  if (m.role === 'owner') throw forbidden()
  await app.store.put({ ...m, role })
  return json(200, { ok: true })
}

/** Removes a member (or lets one leave). Every collection they could read is
 *  marked for key rotation: they may have kept its key. */
export async function removeMember(app: App, userId: string, orgId: string, target: string): Promise<LambdaResponse> {
  const me = await requireMember(app, orgId, userId)
  const self = target === userId
  if (!self && (me.status !== 'confirmed' || me.role === 'member')) throw forbidden()
  const m = await member(app, orgId, target)
  if (!m) throw notFound()
  if (m.role === 'owner') throw new HttpError(409, 'conflict', 'The owner cannot be removed. Delete the organization instead.')
  if (m.role === 'admin' && me.role !== 'owner' && !self) throw forbidden()
  const rotate: string[] = []
  for (const c of await app.store.query(orgPk(orgId), COLLECTION_PREFIX) as Collection[]) {
    const a = await access(app, orgId, c.id, target)
    if (!a) continue
    await app.store.delete(a.pk, a.sk)
    await app.store.put({ ...c, rotationNeeded: true })
    rotate.push(c.id)
  }
  await app.store.delete(orgPk(orgId), orgMemberSk(target))
  await app.store.delete(userPk(target), userOrgSk(orgId))
  return json(200, { ok: true, rotationNeeded: rotate })
}

// ── Collections ───────────────────────────────────────────────────────────

export async function collections(app: App, userId: string, orgId: string): Promise<LambdaResponse> {
  const me = await requireMember(app, orgId, userId, { confirmed: true })
  const all = await app.store.query(orgPk(orgId), COLLECTION_PREFIX) as Collection[]
  const out = []
  for (const c of all) {
    const a = await access(app, orgId, c.id, userId)
    // Admins see every collection (to manage them); members only their own.
    if (!a && me.role === 'member') continue
    out.push({
      id: c.id, nameBlob: c.nameBlob, keyVersion: c.keyVersion, rotationNeeded: !!c.rotationNeeded,
      access: a ? { keyBlob: a.keyBlob, keyVersion: a.keyVersion, permission: a.permission, hidePasswords: a.hidePasswords } : null,
    })
  }
  return json(200, { collections: out })
}

export async function createCollection(app: App, userId: string, event: LambdaEvent, orgId: string): Promise<LambdaResponse> {
  await requireMember(app, orgId, userId, { admin: true })
  const b = body(event)
  const collectionId = id(b['id'], 'id')
  const nameBlob = requireSealed(b['nameBlob'], 'nameBlob', 4096)
  const keyBlob = requireSharedKey(b['keyBlob'], 'keyBlob')
  const c: Collection = { pk: orgPk(orgId), sk: collectionSk(collectionId), id: collectionId, nameBlob, keyVersion: 1, createdAt: now(app) }
  try {
    await app.store.put(c, { mustNotExist: true })
  } catch (err) {
    if (err instanceof AlreadyExists) throw conflict('A collection with that id exists.')
    throw err
  }
  const a: Access = { pk: orgPk(orgId), sk: accessSk(collectionId, userId), collectionId, userId, keyBlob, keyVersion: 1, permission: 'manage', hidePasswords: false }
  await app.store.put(a)
  return json(201, { id: collectionId })
}

export async function renameCollection(app: App, userId: string, event: LambdaEvent, orgId: string, collectionId: string): Promise<LambdaResponse> {
  const { c } = await requireAccess(app, orgId, collectionId, userId, 'manage')
  await app.store.put({ ...c, nameBlob: requireSealed(body(event)['nameBlob'], 'nameBlob', 4096) })
  return json(200, { ok: true })
}

export async function deleteCollection(app: App, userId: string, orgId: string, collectionId: string): Promise<LambdaResponse> {
  const { m } = await requireAccess(app, orgId, collectionId, userId, 'manage')
  if (m.role === 'member') throw forbidden()
  for (const i of await app.store.query(collectionItemsPk(collectionId))) await app.store.delete(i.pk, i.sk)
  for (const a of await app.store.query(orgPk(orgId), accessPrefix(collectionId))) await app.store.delete(a.pk, a.sk)
  await app.store.delete(orgPk(orgId), collectionSk(collectionId))
  return json(200, { ok: true })
}

export async function collectionAccess(app: App, userId: string, orgId: string, collectionId: string): Promise<LambdaResponse> {
  await requireAccess(app, orgId, collectionId, userId, 'manage')
  const grants = (await app.store.query(orgPk(orgId), accessPrefix(collectionId))) as Access[]
  return json(200, { access: grants.map((a) => ({ userId: a.userId, permission: a.permission, hidePasswords: a.hidePasswords, keyVersion: a.keyVersion })) })
}

/** Grants or changes a member's access. A new grant must carry the
 *  collection key sealed to that member — which only someone who can open
 *  the key can produce. */
export async function grantAccess(app: App, userId: string, event: LambdaEvent, orgId: string, collectionId: string, target: string): Promise<LambdaResponse> {
  const { c } = await requireAccess(app, orgId, collectionId, userId, 'manage')
  const t = await member(app, orgId, target)
  if (!t || t.status !== 'confirmed') throw new HttpError(409, 'conflict', 'Only confirmed members can be given access.')
  const b = body(event)
  if (!(PERMISSIONS as readonly unknown[]).includes(b['permission'])) throw badRequest('permission must be view, edit or manage.')
  const existing = await access(app, orgId, collectionId, target)
  const keyBlob = b['keyBlob'] === undefined && existing ? existing.keyBlob : requireSharedKey(b['keyBlob'], 'keyBlob')
  const a: Access = {
    pk: orgPk(orgId), sk: accessSk(collectionId, target), collectionId, userId: target, keyBlob,
    keyVersion: b['keyBlob'] === undefined && existing ? existing.keyVersion : c.keyVersion,
    permission: b['permission'] as Permission, hidePasswords: b['hidePasswords'] === true,
  }
  await app.store.put(a)
  return json(200, { ok: true })
}

export async function revokeAccess(app: App, userId: string, orgId: string, collectionId: string, target: string): Promise<LambdaResponse> {
  const { c } = await requireAccess(app, orgId, collectionId, userId, 'manage')
  const a = await access(app, orgId, collectionId, target)
  if (!a) throw notFound()
  await app.store.delete(a.pk, a.sk)
  await app.store.put({ ...c, rotationNeeded: true })
  return json(200, { ok: true, rotationNeeded: true })
}

// ── Items ─────────────────────────────────────────────────────────────────

export async function items(app: App, userId: string, orgId: string, collectionId: string): Promise<LambdaResponse> {
  await requireAccess(app, orgId, collectionId, userId, 'view')
  const rows = await app.store.query(collectionItemsPk(collectionId), ITEM_PREFIX)
  return json(200, { items: rows.map((r) => ({ id: r['id'], blob: r['blob'], keyVersion: r['keyVersion'], updatedAt: r['updatedAt'] })) })
}

export async function putItem(app: App, userId: string, event: LambdaEvent, orgId: string, collectionId: string, itemId: string): Promise<LambdaResponse> {
  const { c } = await requireAccess(app, orgId, collectionId, userId, 'edit')
  if (!isValidId(itemId)) throw badRequest('item id must be an identifier.')
  const b = body(event)
  const blob = requireSealed(b['blob'], 'blob')
  // Items are written under the current key version only, so a member who
  // still holds a rotated-away key cannot add anything readable to it.
  if (b['keyVersion'] !== c.keyVersion) throw new HttpError(409, 'conflict', 'The collection key changed; reload and try again.')
  const existing = await app.store.get(collectionItemsPk(collectionId), itemSk(itemId))
  const at = now(app)
  await app.store.put({ pk: collectionItemsPk(collectionId), sk: itemSk(itemId), id: itemId, blob, keyVersion: c.keyVersion, createdAt: existing?.['createdAt'] ?? at, updatedAt: at, updatedBy: userId })
  return json(200, { id: itemId })
}

export async function deleteItem(app: App, userId: string, orgId: string, collectionId: string, itemId: string): Promise<LambdaResponse> {
  await requireAccess(app, orgId, collectionId, userId, 'edit')
  if (!isValidId(itemId)) throw notFound()
  await app.store.delete(collectionItemsPk(collectionId), itemSk(itemId))
  return json(200, { ok: true })
}
