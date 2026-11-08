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

import { randomUUID } from 'node:crypto'

import type { App } from '../context.js'
import { HttpError, type LambdaEvent, type LambdaResponse, badRequest, conflict, forbidden, json, notFound, parseJsonBody } from '../http.js'
import { emailDigest } from '../identity.js'
import {
  COLLECTION_PREFIX, ITEM_PREFIX, ORG_INVITE_PREFIX, ORG_MEMBER_PREFIX, ORG_META_SK, ORG_PENDING_PREFIX, PROFILE_SK, USER_ORG_PREFIX,
  GROUP_ACCESS_PREFIX, GROUP_PREFIX, ORG_EVENT_PREFIX, STALE_PREFIX, staleSk, REQUEST_PREFIX, requestSk, EMAIL_SK, SYSTEM_ORG_PREFIX, SYSTEM_PK, orgEventSk, systemOrgSk, accessPrefix, accessSk, collectionItemsPk, legacyCollectionItemsPk, groupAccessSk, groupSk, collectionSk, emailPk, isValidId, itemSk, orgInviteSk, orgMemberSk, orgPendingSk,
  orgPk, userOrgSk, userPk,
} from '../keys.js'
import { AlreadyExists, type Item } from '../store.js'
import { requireEmail, requireSealed, requireSharedKey } from '../validate.js'
import { getSettings } from '../system.js'
import { addNote, addNotes } from '../inbox.js'
import { streamAudit } from '../audit-stream.js'

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
  /** Groups chosen when they were invited (B2). Joined by the admin's app at
   *  confirmation, because group access needs keys sealed to them there. */
  pendingGroups?: string[]
}

interface Access extends Item {
  collectionId: string
  userId: string
  keyBlob: string
  keyVersion: number
  permission: Permission
  hidePasswords: boolean
  /** Granted because the member is in this group; removed with it. */
  viaGroup?: string
  /** A check-out (D7): access ends at this instant (ISO 8601). */
  until?: string
}

interface Group extends Item {
  id: string
  nameBlob: string
  members: string[]
}

interface GroupAccess extends Item {
  collectionId: string
  groupId: string
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
  const a = (await app.store.get(orgPk(orgId), accessSk(collectionId, userId))) as Access | null
  // A check-out that has run out ends here, the first time anything looks:
  // the row goes, the collection is marked for a key rotation, and they are told.
  if (a?.until && Date.parse(a.until) <= app.now()) {
    await app.store.delete(a.pk, a.sk)
    const c = await app.store.get(orgPk(orgId), collectionSk(collectionId))
    if (c) await app.store.put({ ...c, rotationNeeded: true })
    await orgEvent(app, orgId, 'system', 'access.expire', { collectionId, target: userId })
    await addNote(app, userId, 'access-ended', { orgId, collectionId })
    return null
  }
  return a
}

/** The owner and admins who can act on a request or a sensitive-item alert. */
async function managers(app: App, orgId: string, except?: string): Promise<string[]> {
  return ((await app.store.query(orgPk(orgId), ORG_MEMBER_PREFIX)) as Member[])
    .filter((m) => m.status === 'confirmed' && m.role !== 'member' && m.userId !== except).map((m) => m.userId)
}

export interface Policies { requireTwoFactor: boolean; minPasswordScore: number; maxIdleMinutes: number | null }
const DEFAULT_POLICIES: Policies = { requireTwoFactor: false, minPasswordScore: 0, maxIdleMinutes: null }

async function policiesOf(app: App, orgId: string): Promise<Policies> {
  const meta = await app.store.get(orgPk(orgId), ORG_META_SK)
  return { ...DEFAULT_POLICIES, ...((meta?.['policies'] as Partial<Policies>) ?? {}) }
}

/** What stops this account meeting the organization's policies, if anything. */
async function policyGap(app: App, orgId: string, userId: string): Promise<string | null> {
  const p = await policiesOf(app, orgId)
  if (!p.requireTwoFactor && !p.minPasswordScore) return null
  const profile = await app.store.get(userPk(userId), PROFILE_SK)
  if (p.requireTwoFactor && !profile?.['totp']) return 'This organization requires two-factor sign-in. Turn it on in Settings.'
  if (p.minPasswordScore && Number(profile?.['passwordScore'] ?? 0) < p.minPasswordScore) return 'This organization requires a stronger master password. Change it in Settings.'
  return null
}

async function requireCompliant(app: App, orgId: string, userId: string): Promise<void> {
  const gap = await policyGap(app, orgId, userId)
  if (gap) throw new HttpError(403, 'policy_required', gap)
}

async function requireAccess(app: App, orgId: string, collectionId: string, userId: string, at: Permission): Promise<{ m: Member; a: Access; c: Collection }> {
  const m = await requireMember(app, orgId, userId, { confirmed: true })
  await requireCompliant(app, orgId, userId)
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

/** Before an account is deleted: leave every organization it belongs to
 *  (re-key flags as for a removal), or report the ones it owns, which must be
 *  deleted or handed over first. */
export async function leaveAllOrgs(app: App, userId: string, dryRun: boolean): Promise<{ owned: string[] }> {
  const owned: string[] = []
  for (const p of await app.store.query(userPk(userId), USER_ORG_PREFIX)) {
    const orgId = String(p['orgId'])
    const m = await member(app, orgId, userId)
    if (!m) { if (!dryRun) await app.store.delete(p.pk, p.sk); continue }
    if (m.role === 'owner') { owned.push(String((await app.store.get(orgPk(orgId), ORG_META_SK))?.['hint'] ?? orgId)); continue }
    if (dryRun) continue
    await detachMember(app, orgId, m, 'system', 'member.remove')
  }
  return { owned }
}

// ── Data migration: organization-scoped item partitions ──────────────────

const ITEMS_MIGRATION = 'DATAMIG#collection-items-by-org'

/** Moves items from the old COLLI#<collection> partitions to
 *  COLLI#<org>#<collection>, once. If two organizations used the same
 *  collection id, the items belong to the collection created first — a later
 *  one with the same id could only have been made to reach them. */
export async function migrateItemPartitions(app: App): Promise<number> {
  if (await app.store.get(SYSTEM_PK, ITEMS_MIGRATION)) return 0
  const owners = new Map<string, { orgId: string; createdAt: string }>()
  for (const ix of await app.store.query(SYSTEM_PK, SYSTEM_ORG_PREFIX)) {
    const orgId = String(ix['orgId'])
    for (const c of await app.store.query(orgPk(orgId), COLLECTION_PREFIX) as Collection[]) {
      const prev = owners.get(c.id)
      if (!prev || c.createdAt < prev.createdAt) owners.set(c.id, { orgId, createdAt: c.createdAt })
    }
  }
  let moved = 0
  for (const [collectionId, { orgId }] of owners) {
    for (const row of await app.store.query(legacyCollectionItemsPk(collectionId), ITEM_PREFIX)) {
      await app.store.put({ ...row, pk: collectionItemsPk(orgId, collectionId) })
      await app.store.delete(row.pk, row.sk)
      moved++
    }
  }
  await app.store.put({ pk: SYSTEM_PK, sk: ITEMS_MIGRATION, at: new Date(app.now()).toISOString(), moved })
  return moved
}

// ── Access audit ──────────────────────────────────────────────────────────
// Events on ciphertext the server cannot read: who did what to which item
// id, in which collection. Writes, grants and membership changes are recorded
// here as they happen; opening, revealing and copying happen only in a
// member's app, which reports them (and a modified app could stay silent —
// the log says so). Kept as long as the server policy's audit retention.

export const CLIENT_EVENTS = ['view', 'reveal', 'copy'] as const

export async function orgEvent(app: App, orgId: string, actor: string, action: string, extra: { collectionId?: string; itemId?: string; target?: string; reported?: boolean } = {}): Promise<void> {
  const at = new Date(app.now()).toISOString()
  await app.store.put({
    pk: orgPk(orgId), sk: orgEventSk(at, randomUUID().slice(0, 8)), at, actor, action, ...extra,
    expiresAt: Math.floor(app.now() / 1000) + (await getSettings(app)).policy.auditDays * 86_400,
  })
  streamAudit(app, { source: 'organization', at, actor, action, orgId, ...(extra.collectionId ? { collectionId: extra.collectionId } : {}), ...(extra.itemId ? { itemId: extra.itemId } : {}), ...(extra.target ? { target: extra.target } : {}) })
}

/** A member's app reports opening, revealing or copying a shared item. */
export async function reportEvent(app: App, userId: string, event: LambdaEvent, orgId: string): Promise<LambdaResponse> {
  const b = body(event)
  const action = b['action']
  if (!(CLIENT_EVENTS as readonly unknown[]).includes(action)) throw badRequest('action must be view, reveal or copy.')
  const collectionId = String(b['collectionId'] ?? '')
  const itemId = id(b['itemId'], 'itemId')
  const { m } = await requireAccess(app, orgId, collectionId, userId, 'view')
  await orgEvent(app, orgId, userId, `item.${action as string}`, { collectionId, itemId, reported: true })
  const row = await app.store.get(collectionItemsPk(orgId, collectionId), itemSk(itemId))
  if (row?.['sensitive']) await addNotes(app, await managers(app, orgId, userId), 'sensitive-opened', { orgId, collectionId, itemId, who: m.label, action: action as string })
  return json(201, { ok: true })
}

export async function events(app: App, userId: string, orgId: string): Promise<LambdaResponse> {
  await requireMember(app, orgId, userId, { admin: true })
  const rows = await app.store.query(orgPk(orgId), ORG_EVENT_PREFIX)
  rows.sort((a, b) => String(b['at']).localeCompare(String(a['at'])))
  return json(200, { events: rows.slice(0, 500).map((r) => ({
    at: r['at'], actor: r['actor'], action: r['action'], collectionId: r['collectionId'] ?? null, itemId: r['itemId'] ?? null, target: r['target'] ?? null, reported: !!r['reported'],
  })) })
}

// ── Organizations ─────────────────────────────────────────────────────────

export async function createOrg(app: App, userId: string, event: LambdaEvent): Promise<LambdaResponse> {
  const b = body(event)
  const orgId = id(b['id'], 'id')
  const nameBlob = requireSealed(b['nameBlob'], 'nameBlob', 4096)
  const orgKeyBlob = requireSharedKey(b['orgKeyBlob'], 'orgKeyBlob')
  const hint = label(b['hint'], 'hint').slice(0, MAX_HINT)
  // 'direct' (D11): a private space between two people, made by "Share with a
  // person". The same keys, confirmation and audit as any organization; only
  // the size is fixed and the app presents it as a person, not a team.
  const kind = b['kind'] === 'direct' ? 'direct' : 'team'
  const publicKey = await publicKeyOf(app, userId)
  const at = now(app)
  try {
    await app.store.put({ pk: orgPk(orgId), sk: ORG_META_SK, id: orgId, nameBlob, hint, kind, createdAt: at, createdBy: userId }, { mustNotExist: true })
  } catch (err) {
    if (err instanceof AlreadyExists) throw conflict('An organization with that id exists.')
    throw err
  }
  const owner: Member = { pk: orgPk(orgId), sk: orgMemberSk(userId), userId, role: 'owner', status: 'confirmed', label: label(b['label']) || 'Owner', publicKey, orgKeyBlob, joinedAt: at, confirmedAt: at }
  await app.store.put(owner)
  await app.store.put({ pk: userPk(userId), sk: userOrgSk(orgId), orgId })
  await app.store.put({ pk: SYSTEM_PK, sk: systemOrgSk(orgId), orgId, createdAt: at, createdBy: userId })
  return json(201, { id: orgId })
}

export async function myOrgs(app: App, userId: string): Promise<LambdaResponse> {
  const pointers = await app.store.query(userPk(userId), USER_ORG_PREFIX)
  const orgs = []
  for (const p of pointers) {
    const orgId = String(p['orgId'])
    const [meta, m] = await Promise.all([app.store.get(orgPk(orgId), ORG_META_SK), member(app, orgId, userId)])
    if (!meta || !m) continue
    const policies = { ...DEFAULT_POLICIES, ...((meta['policies'] as Partial<Policies>) ?? {}) }
    orgs.push({
      id: orgId, nameBlob: meta['nameBlob'], hint: meta['hint'] ?? '', kind: meta['kind'] === 'direct' ? 'direct' : 'team', role: m.role, status: m.status, policies,
      policyGap: m.status === 'confirmed' ? await policyGap(app, orgId, userId) : null,
      ...(m.orgKeyBlob ? { orgKeyBlob: m.orgKeyBlob } : {}),
    })
  }
  return json(200, { orgs })
}

export async function deleteOrg(app: App, userId: string, orgId: string): Promise<LambdaResponse> {
  await requireMember(app, orgId, userId, { owner: true })
  await purgeOrg(app, orgId)
  return json(200, { ok: true })
}

/** Removes an organization and everything in it. */
export async function purgeOrg(app: App, orgId: string): Promise<void> {
  for (const c of await app.store.query(orgPk(orgId), COLLECTION_PREFIX)) {
    for (const i of await app.store.query(collectionItemsPk(orgId, String(c['id'])))) await app.store.delete(i.pk, i.sk)
  }
  for (const row of await app.store.query(orgPk(orgId))) {
    if (row.sk.startsWith(ORG_MEMBER_PREFIX)) await app.store.delete(userPk(String(row['userId'])), userOrgSk(orgId))
    if (row.sk.startsWith(ORG_PENDING_PREFIX)) await app.store.delete(emailPk(row.sk.slice(ORG_PENDING_PREFIX.length)), orgInviteSk(orgId))
    await app.store.delete(row.pk, row.sk)
  }
  await app.store.delete(SYSTEM_PK, systemOrgSk(orgId))
}

/** For the server operator: every organization, by counts and the display
 *  name its creator typed — never its contents, which they cannot open. */
export async function adminList(app: App): Promise<LambdaResponse> {
  const index = await app.store.query(SYSTEM_PK, SYSTEM_ORG_PREFIX)
  const out = []
  for (const ix of index) {
    const orgId = String(ix['orgId'])
    const rows = await app.store.query(orgPk(orgId))
    const meta = rows.find((r) => r.sk === ORG_META_SK)
    if (!meta) continue
    const members = rows.filter((r) => r.sk.startsWith(ORG_MEMBER_PREFIX)) as Member[]
    const colls = rows.filter((r) => r.sk.startsWith(COLLECTION_PREFIX)) as Collection[]
    let items = 0
    for (const c of colls) items += (await app.store.query(collectionItemsPk(orgId, c.id), ITEM_PREFIX)).length
    out.push({
      id: orgId, hint: meta['hint'] ?? '', createdAt: meta['createdAt'], ownerId: members.find((m) => m.role === 'owner')?.userId ?? null,
      members: members.filter((m) => m.status === 'confirmed').length, awaiting: members.filter((m) => m.status !== 'confirmed').length,
      pending: rows.filter((r) => r.sk.startsWith(ORG_PENDING_PREFIX)).length, collections: colls.length, items,
      rotationDue: colls.filter((c) => c.rotationNeeded).length,
      policies: { ...DEFAULT_POLICIES, ...((meta['policies'] as Partial<Policies>) ?? {}) },
    })
  }
  out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  return json(200, { orgs: out })
}

export async function setPolicies(app: App, userId: string, event: LambdaEvent, orgId: string): Promise<LambdaResponse> {
  await requireMember(app, orgId, userId, { admin: true })
  const b = body(event)
  const score = Number(b['minPasswordScore'] ?? 0)
  const idle = b['maxIdleMinutes'] === null || b['maxIdleMinutes'] === undefined ? null : Number(b['maxIdleMinutes'])
  if (!Number.isInteger(score) || score < 0 || score > 4) throw badRequest('minPasswordScore must be 0 to 4.')
  if (idle !== null && (!Number.isInteger(idle) || idle < 1 || idle > 15)) throw badRequest('maxIdleMinutes must be 1 to 15, or null.')
  const policies: Policies = { requireTwoFactor: b['requireTwoFactor'] === true, minPasswordScore: score, maxIdleMinutes: idle }
  const meta = await app.store.get(orgPk(orgId), ORG_META_SK)
  if (!meta) throw notFound()
  await app.store.put({ ...meta, policies })
  await orgEvent(app, orgId, userId, 'policies.change')
  return json(200, { policies })
}

/** For admins: which members do not meet the policies (never why in detail
 *  beyond the policy name). */
export async function compliance(app: App, userId: string, orgId: string): Promise<LambdaResponse> {
  await requireMember(app, orgId, userId, { admin: true })
  const ms = (await app.store.query(orgPk(orgId), ORG_MEMBER_PREFIX)) as Member[]
  const out = []
  for (const m of ms) out.push({ userId: m.userId, gap: m.status === 'confirmed' ? await policyGap(app, orgId, m.userId) : null })
  return json(200, { members: out })
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
  const meta0 = await app.store.get(orgPk(orgId), ORG_META_SK)
  if (meta0?.['kind'] === 'direct') {
    const rows = await app.store.query(orgPk(orgId))
    const people = rows.filter((r) => r.sk.startsWith(ORG_MEMBER_PREFIX) || (r.sk.startsWith(ORG_PENDING_PREFIX) && r['digest'] !== digest)).length
    if (people >= 2) throw conflict('A direct share is between two people. Share with someone else separately.')
  }
  // Groups to join once confirmed (B2): ids of this organization's groups.
  const raw = Array.isArray(b['groups']) ? b['groups'] : []
  if (raw.length > 20) throw badRequest('groups holds at most 20 ids.')
  const known = new Set(((await app.store.query(orgPk(orgId), GROUP_PREFIX)) as Group[]).map((g) => g.id))
  const groups = [...new Set(raw.map((g) => String(g)))]
  if (groups.some((g) => !known.has(g))) throw badRequest('groups must be groups of this organization.')
  const meta = await app.store.get(orgPk(orgId), ORG_META_SK)
  const at = now(app)
  // Both rows are written whether or not the address has an account: the
  // response is the same, and the invitation waits for them to sign in.
  await app.store.put({ pk: orgPk(orgId), sk: orgPendingSk(digest), digest, role, label: memberLabel, invitedBy: userId, invitedAt: at, ...(groups.length ? { groups } : {}) })
  await app.store.put({ pk: emailPk(digest), sk: orgInviteSk(orgId), orgId, role, label: memberLabel, hint: meta?.['hint'] ?? '', invitedAt: at })
  await orgEvent(app, orgId, userId, 'member.invite', { target: memberLabel })
  // If they already have an account, it shows in their notifications too.
  const pointer = await app.store.get(emailPk(digest), EMAIL_SK)
  if (pointer?.['userId']) await addNote(app, String(pointer['userId']), 'org-invite', { orgId, hint: String(meta?.['hint'] ?? '') })
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
  const pendingRow = await app.store.get(orgPk(orgId), orgPendingSk(digest))
  const pendingGroups = Array.isArray(pendingRow?.['groups']) ? (pendingRow!['groups'] as string[]) : []
  const m: Member = { pk: orgPk(orgId), sk: orgMemberSk(userId), userId, role: inv['role'] === 'admin' ? 'admin' : 'member', status: 'accepted', label: String(inv['label'] ?? 'Member'), publicKey, joinedAt: now(app), ...(pendingGroups.length ? { pendingGroups } : {}) }
  try {
    await app.store.put(m, { mustNotExist: true })
  } catch (err) {
    if (!(err instanceof AlreadyExists)) throw err
  }
  await app.store.put({ pk: userPk(userId), sk: userOrgSk(orgId), orgId })
  await app.store.delete(emailPk(digest), orgInviteSk(orgId))
  await app.store.delete(orgPk(orgId), orgPendingSk(digest))
  await addNotes(app, await managers(app, orgId, userId), 'member-accepted', { orgId, who: m.label })
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
    pendingGroups: me.role === 'member' ? [] : (m.pendingGroups ?? []),
  }))
  const pending = me.role === 'member' ? [] : rows.filter((r) => r.sk.startsWith(ORG_PENDING_PREFIX))
    .map((r) => ({ id: r['digest'], label: r['label'], role: r['role'], invitedAt: r['invitedAt'], groups: r['groups'] ?? [] }))
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
  await orgEvent(app, orgId, userId, 'member.confirm', { target })
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
  const { rotate, stale } = await detachMember(app, orgId, m, userId, self ? 'member.leave' : 'member.remove')
  return json(200, { ok: true, rotationNeeded: rotate, passwordsToChange: stale })
}

/** Takes a member out of an organization (B9): their access goes, every
 *  collection they could open is marked for a key rotation, and every item in
 *  those collections is listed as having a password they could have seen —
 *  until someone changes it. Their key copy only opens what existed before
 *  rotation; the passwords themselves are still in their memory or notes. */
async function detachMember(app: App, orgId: string, m: Member, actor: string, action: string): Promise<{ rotate: string[]; stale: number }> {
  const target = m.userId
  const rotate: string[] = []
  let stale = 0
  const since = now(app)
  for (const c of await app.store.query(orgPk(orgId), COLLECTION_PREFIX) as Collection[]) {
    const a = await access(app, orgId, c.id, target)
    if (!a) continue
    await app.store.delete(a.pk, a.sk)
    await app.store.put({ ...c, rotationNeeded: true })
    rotate.push(c.id)
    for (const it of await app.store.query(collectionItemsPk(orgId, c.id), ITEM_PREFIX)) {
      await app.store.put({ pk: orgPk(orgId), sk: staleSk(c.id, String(it['id'])), collectionId: c.id, itemId: it['id'], since, who: m.label })
      stale++
    }
  }
  for (const g of (await app.store.query(orgPk(orgId), GROUP_PREFIX)) as Group[]) {
    if (g.members.includes(target)) await app.store.put({ ...g, members: g.members.filter((x) => x !== target) })
  }
  await app.store.delete(orgPk(orgId), orgMemberSk(target))
  await app.store.delete(userPk(target), userOrgSk(orgId))
  await orgEvent(app, orgId, actor, action, { target })
  return { rotate, stale }
}

/** Items whose password someone who left could have seen, limited to the
 *  collections the caller can open. */
export async function staleItems(app: App, userId: string, orgId: string): Promise<LambdaResponse> {
  await requireMember(app, orgId, userId, { confirmed: true })
  const rows = await app.store.query(orgPk(orgId), STALE_PREFIX)
  const mine = new Set<string>()
  for (const cid of new Set(rows.map((r) => String(r['collectionId'])))) if (await access(app, orgId, cid, userId)) mine.add(cid)
  return json(200, { items: rows.filter((r) => mine.has(String(r['collectionId']))).map((r) => ({ collectionId: r['collectionId'], itemId: r['itemId'], since: r['since'], who: r['who'] })) })
}

// ── Collections ───────────────────────────────────────────────────────────

export async function collections(app: App, userId: string, orgId: string): Promise<LambdaResponse> {
  const me = await requireMember(app, orgId, userId, { confirmed: true })
  await requireCompliant(app, orgId, userId)
  const all = await app.store.query(orgPk(orgId), COLLECTION_PREFIX) as Collection[]
  const out = []
  for (const c of all) {
    const a = await access(app, orgId, c.id, userId)
    // Everyone confirmed sees every collection's name (they hold the org key
    // that seals it anyway), so a member can ask for one they lack (D7).
    const requested = !a && me.role === 'member' ? Boolean(await app.store.get(orgPk(orgId), requestSk(c.id, userId))) : false
    out.push({
      id: c.id, nameBlob: c.nameBlob, keyVersion: c.keyVersion, rotationNeeded: !!c.rotationNeeded,
      access: a ? { keyBlob: a.keyBlob, keyVersion: a.keyVersion, permission: a.permission, hidePasswords: a.hidePasswords, ...(a.until ? { until: a.until } : {}) } : null,
      ...(requested ? { requested } : {}),
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
  await orgEvent(app, orgId, userId, 'collection.create', { collectionId })
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
  for (const i of await app.store.query(collectionItemsPk(orgId, collectionId))) await app.store.delete(i.pk, i.sk)
  for (const a of await app.store.query(orgPk(orgId), accessPrefix(collectionId))) await app.store.delete(a.pk, a.sk)
  await app.store.delete(orgPk(orgId), collectionSk(collectionId))
  await orgEvent(app, orgId, userId, 'collection.delete', { collectionId })
  return json(200, { ok: true })
}

export async function collectionAccess(app: App, userId: string, orgId: string, collectionId: string): Promise<LambdaResponse> {
  await requireAccess(app, orgId, collectionId, userId, 'manage')
  const grants = (await app.store.query(orgPk(orgId), accessPrefix(collectionId))) as Access[]
  return json(200, { access: grants.map((a) => ({ userId: a.userId, permission: a.permission, hidePasswords: a.hidePasswords, keyVersion: a.keyVersion, viaGroup: a.viaGroup ?? null })) })
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
    ...(typeof b['viaGroup'] === 'string' && isValidId(b['viaGroup']) ? { viaGroup: b['viaGroup'] } : existing?.viaGroup ? { viaGroup: existing.viaGroup } : {}),
  }
  // A check-out (D7): access for a few hours or days, then it ends by itself.
  if (b['hours'] !== undefined && b['hours'] !== null) {
    if (!(CHECKOUT_HOURS as readonly unknown[]).includes(b['hours'])) throw badRequest(`hours must be one of: ${CHECKOUT_HOURS.join(', ')}.`)
    a.until = new Date(app.now() + (b['hours'] as number) * 3_600_000).toISOString()
  }
  await app.store.put(a)
  await orgEvent(app, orgId, userId, existing ? 'access.change' : 'access.grant', { collectionId, target, ...(a.until ? { reported: false } : {}) })
  if (await app.store.get(orgPk(orgId), requestSk(collectionId, target))) {
    await app.store.delete(orgPk(orgId), requestSk(collectionId, target))
    await addNote(app, target, 'access-granted', { orgId, collectionId, until: a.until ?? null })
  }
  return json(200, { ok: true })
}

export const CHECKOUT_HOURS = [1, 8, 24, 72, 168] as const

/** A member asks for a collection they cannot open (D7). The owner and
 *  admins are told; one of them approves by granting access (for a while, or
 *  for good), or turns it down. */
export async function requestAccess(app: App, userId: string, event: LambdaEvent, orgId: string, collectionId: string): Promise<LambdaResponse> {
  const me = await requireMember(app, orgId, userId, { confirmed: true })
  await requireCompliant(app, orgId, userId)
  if (!isValidId(collectionId) || !(await app.store.get(orgPk(orgId), collectionSk(collectionId)))) throw notFound()
  if (await access(app, orgId, collectionId, userId)) throw conflict('You can already open this collection.')
  const reason = String(body(event)['reason'] ?? '').trim().slice(0, 200)
  if (/[\u0000-\u001f<>]/.test(reason)) throw badRequest('reason must be plain text.')
  const at = now(app)
  await app.store.put({ pk: orgPk(orgId), sk: requestSk(collectionId, userId), collectionId, userId, label: me.label, reason, at })
  await orgEvent(app, orgId, userId, 'access.request', { collectionId })
  await addNotes(app, await managers(app, orgId, userId), 'access-request', { orgId, collectionId, who: me.label, reason })
  return json(201, { ok: true })
}

export async function listRequests(app: App, userId: string, orgId: string): Promise<LambdaResponse> {
  await requireMember(app, orgId, userId, { admin: true })
  const rows = await app.store.query(orgPk(orgId), REQUEST_PREFIX)
  return json(200, { requests: rows.map((r) => ({ collectionId: r['collectionId'], userId: r['userId'], label: r['label'], reason: r['reason'] ?? '', at: r['at'] })) })
}

export async function denyRequest(app: App, userId: string, orgId: string, collectionId: string, target: string): Promise<LambdaResponse> {
  await requireAccess(app, orgId, collectionId, userId, 'manage')
  if (!(await app.store.get(orgPk(orgId), requestSk(collectionId, target)))) throw notFound()
  await app.store.delete(orgPk(orgId), requestSk(collectionId, target))
  await orgEvent(app, orgId, userId, 'access.deny', { collectionId, target })
  await addNote(app, target, 'access-denied', { orgId, collectionId })
  return json(200, { ok: true })
}

/** Marks an item sensitive (D12): the owner and admins are told each time a
 *  member opens, reveals or copies it. Their app reports those (A10). */
export async function setSensitive(app: App, userId: string, event: LambdaEvent, orgId: string, collectionId: string, itemId: string): Promise<LambdaResponse> {
  await requireAccess(app, orgId, collectionId, userId, 'manage')
  const row = isValidId(itemId) ? await app.store.get(collectionItemsPk(orgId, collectionId), itemSk(itemId)) : null
  if (!row) throw notFound()
  const sensitive = body(event)['sensitive'] === true
  await app.store.put({ ...row, sensitive })
  await orgEvent(app, orgId, userId, sensitive ? 'item.sensitive' : 'item.not-sensitive', { collectionId, itemId })
  return json(200, { sensitive })
}

export async function revokeAccess(app: App, userId: string, orgId: string, collectionId: string, target: string): Promise<LambdaResponse> {
  const { c } = await requireAccess(app, orgId, collectionId, userId, 'manage')
  const a = await access(app, orgId, collectionId, target)
  if (!a) throw notFound()
  await app.store.delete(a.pk, a.sk)
  await app.store.put({ ...c, rotationNeeded: true })
  await orgEvent(app, orgId, userId, 'access.revoke', { collectionId, target })
  return json(200, { ok: true, rotationNeeded: true })
}

/** Replaces a collection's key in one step: every current grant gets the new
 *  key sealed to it, every current item is re-encrypted under it, and the
 *  version moves on. The request must match the collection exactly — any
 *  grant or item added meanwhile fails it with 409, and the client retries —
 *  so nothing is left readable only under the retired key. */
export async function rotateCollection(app: App, userId: string, event: LambdaEvent, orgId: string, collectionId: string): Promise<LambdaResponse> {
  const { c } = await requireAccess(app, orgId, collectionId, userId, 'manage')
  const b = body(event)
  if (b['keyVersion'] !== c.keyVersion + 1) throw new HttpError(409, 'conflict', 'The collection key changed; reload and rotate again.')
  const grants = Array.isArray(b['grants']) ? b['grants'] as Record<string, unknown>[] : null
  const itemsIn = Array.isArray(b['items']) ? b['items'] as Record<string, unknown>[] : null
  // Items the rotating member could not decrypt (planted, or damaged) are
  // named here and removed, so one bad item can never block a rotation.
  const drop = (Array.isArray(b['drop']) ? b['drop'] : []).map(String)
  if (!grants || !itemsIn) throw badRequest('grants and items are required.')
  const current = (await app.store.query(orgPk(orgId), accessPrefix(collectionId))) as Access[]
  const stored = await app.store.query(collectionItemsPk(orgId, collectionId), ITEM_PREFIX)
  const same = (a: string[], b2: string[]) => a.length === b2.length && [...a].sort().join() === [...b2].sort().join()
  if (!same(current.map((a) => a.userId), grants.map((g) => String(g['userId'])))) throw new HttpError(409, 'conflict', 'Who can open this collection changed; reload and rotate again.')
  if (!same(stored.map((i) => String(i['id'])), [...itemsIn.map((i) => String(i['id'])), ...drop])) throw new HttpError(409, 'conflict', 'The items changed; reload and rotate again.')
  const version = c.keyVersion + 1
  const sealedGrants = grants.map((g) => ({ userId: String(g['userId']), keyBlob: requireSharedKey(g['keyBlob'], 'keyBlob') }))
  const sealedItems = itemsIn.map((i) => ({ id: String(i['id']), blob: requireSealed(i['blob'], 'blob') }))
  const at = now(app)
  for (const g of sealedGrants) {
    const a = current.find((x) => x.userId === g.userId)!
    await app.store.put({ ...a, keyBlob: g.keyBlob, keyVersion: version })
  }
  for (const d of drop) await app.store.delete(collectionItemsPk(orgId, collectionId), itemSk(d))
  for (const i of sealedItems) {
    const old = stored.find((x) => x['id'] === i.id)!
    await app.store.put({ ...old, blob: i.blob, keyVersion: version, updatedAt: at, updatedBy: userId })
  }
  const { rotationNeeded: _r, ...rest } = c
  await app.store.put({ ...rest, keyVersion: version, rotatedAt: at } as Collection)
  await orgEvent(app, orgId, userId, 'collection.rotate', { collectionId, ...(drop.length ? { target: `${drop.length} unreadable item(s) removed` } : {}) })
  return json(200, { keyVersion: version })
}

// ── Groups ────────────────────────────────────────────────────────────────
// A group is a named set of confirmed members. Granting a collection to a
// group gives each member their own sealed key (tagged viaGroup); adding a
// member to the group later is followed by the client sealing the group's
// collections to them; removing one revokes those grants and marks the
// collections for rotation.

async function requireGroup(app: App, orgId: string, groupId: string): Promise<Group> {
  if (!isValidId(groupId)) throw notFound()
  const g = (await app.store.get(orgPk(orgId), groupSk(groupId))) as Group | null
  if (!g) throw notFound()
  return g
}

async function revokeVia(app: App, orgId: string, groupId: string, collectionId?: string, userId?: string): Promise<string[]> {
  const rotate = new Set<string>()
  const rows = (await app.store.query(orgPk(orgId), collectionId ? accessPrefix(collectionId) : 'ACCESS#')) as Access[]
  for (const a of rows) {
    if (a.viaGroup !== groupId || (userId && a.userId !== userId)) continue
    await app.store.delete(a.pk, a.sk)
    rotate.add(a.collectionId)
  }
  for (const cid of rotate) {
    const c = (await app.store.get(orgPk(orgId), collectionSk(cid))) as Collection | null
    if (c) await app.store.put({ ...c, rotationNeeded: true })
  }
  return [...rotate]
}

export async function groups(app: App, userId: string, orgId: string): Promise<LambdaResponse> {
  await requireMember(app, orgId, userId, { confirmed: true })
  const rows = await app.store.query(orgPk(orgId))
  const gs = rows.filter((r) => r.sk.startsWith(GROUP_PREFIX)) as Group[]
  const ga = rows.filter((r) => r.sk.startsWith(GROUP_ACCESS_PREFIX)) as GroupAccess[]
  return json(200, { groups: gs.map((g) => ({
    id: g.id, nameBlob: g.nameBlob, members: g.members,
    collections: ga.filter((x) => x.groupId === g.id).map((x) => ({ collectionId: x.collectionId, permission: x.permission, hidePasswords: x.hidePasswords })),
  })) })
}

export async function createGroup(app: App, userId: string, event: LambdaEvent, orgId: string): Promise<LambdaResponse> {
  await requireMember(app, orgId, userId, { admin: true })
  const b = body(event)
  const groupId = id(b['id'], 'id')
  const g: Group = { pk: orgPk(orgId), sk: groupSk(groupId), id: groupId, nameBlob: requireSealed(b['nameBlob'], 'nameBlob', 4096), members: [] }
  try { await app.store.put(g, { mustNotExist: true }) } catch (err) { if (err instanceof AlreadyExists) throw conflict('That group exists.'); throw err }
  return json(201, { id: groupId })
}

export async function deleteGroup(app: App, userId: string, orgId: string, groupId: string): Promise<LambdaResponse> {
  await requireMember(app, orgId, userId, { admin: true })
  await requireGroup(app, orgId, groupId)
  const rotate = await revokeVia(app, orgId, groupId)
  for (const r of await app.store.query(orgPk(orgId), GROUP_ACCESS_PREFIX)) if (r['groupId'] === groupId) await app.store.delete(r.pk, r.sk)
  await app.store.delete(orgPk(orgId), groupSk(groupId))
  return json(200, { ok: true, rotationNeeded: rotate })
}

export async function addGroupMember(app: App, userId: string, orgId: string, groupId: string, target: string): Promise<LambdaResponse> {
  await requireMember(app, orgId, userId, { admin: true })
  const g = await requireGroup(app, orgId, groupId)
  const t = await member(app, orgId, target)
  if (!t || t.status !== 'confirmed') throw new HttpError(409, 'conflict', 'Only confirmed members can join a group.')
  if (!g.members.includes(target)) await app.store.put({ ...g, members: [...g.members, target] })
  if (t.pendingGroups?.includes(groupId)) await app.store.put({ ...t, pendingGroups: t.pendingGroups.filter((x) => x !== groupId) })
  // The client now seals the group's collections to them (grantAccess with viaGroup).
  const pendingCollections = ((await app.store.query(orgPk(orgId), GROUP_ACCESS_PREFIX)) as GroupAccess[]).filter((x) => x.groupId === groupId)
  return json(200, { ok: true, collections: pendingCollections.map((x) => ({ collectionId: x.collectionId, permission: x.permission, hidePasswords: x.hidePasswords })) })
}

export async function removeGroupMember(app: App, userId: string, orgId: string, groupId: string, target: string): Promise<LambdaResponse> {
  await requireMember(app, orgId, userId, { admin: true })
  const g = await requireGroup(app, orgId, groupId)
  await app.store.put({ ...g, members: g.members.filter((m) => m !== target) })
  return json(200, { ok: true, rotationNeeded: await revokeVia(app, orgId, groupId, undefined, target) })
}

/** Grants a collection to a group: one sealed key per member who does not
 *  already have access, all in this request. */
export async function grantGroup(app: App, userId: string, event: LambdaEvent, orgId: string, collectionId: string, groupId: string): Promise<LambdaResponse> {
  const { c } = await requireAccess(app, orgId, collectionId, userId, 'manage')
  const g = await requireGroup(app, orgId, groupId)
  const b = body(event)
  if (!(PERMISSIONS as readonly unknown[]).includes(b['permission'])) throw badRequest('permission must be view, edit or manage.')
  const permission = b['permission'] as Permission
  const hidePasswords = b['hidePasswords'] === true
  const sealed = (Array.isArray(b['grants']) ? b['grants'] : []) as Record<string, unknown>[]
  const need: string[] = []
  for (const m of g.members) if (!(await access(app, orgId, collectionId, m))) need.push(m)
  const given = new Map(sealed.map((x) => [String(x['userId']), requireSharedKey(x['keyBlob'], 'keyBlob')]))
  const missing = need.filter((m) => !given.has(m))
  if (missing.length) throw new HttpError(409, 'conflict', 'The group\'s members changed; reload and try again.')
  await app.store.put({ pk: orgPk(orgId), sk: groupAccessSk(collectionId, groupId), collectionId, groupId, permission, hidePasswords })
  for (const m of need) {
    await app.store.put({ pk: orgPk(orgId), sk: accessSk(collectionId, m), collectionId, userId: m, keyBlob: given.get(m)!, keyVersion: c.keyVersion, permission, hidePasswords, viaGroup: groupId } as Access)
  }
  await orgEvent(app, orgId, userId, 'access.grant-group', { collectionId, target: groupId })
  return json(200, { ok: true, granted: need.length })
}

export async function revokeGroup(app: App, userId: string, orgId: string, collectionId: string, groupId: string): Promise<LambdaResponse> {
  await requireAccess(app, orgId, collectionId, userId, 'manage')
  await app.store.delete(orgPk(orgId), groupAccessSk(collectionId, groupId))
  return json(200, { ok: true, rotationNeeded: await revokeVia(app, orgId, groupId, collectionId) })
}

// ── Items ─────────────────────────────────────────────────────────────────

export async function items(app: App, userId: string, orgId: string, collectionId: string): Promise<LambdaResponse> {
  await requireAccess(app, orgId, collectionId, userId, 'view')
  const rows = await app.store.query(collectionItemsPk(orgId, collectionId), ITEM_PREFIX)
  return json(200, { items: rows.map((r) => ({ id: r['id'], blob: r['blob'], keyVersion: r['keyVersion'], updatedAt: r['updatedAt'], ...(r['sensitive'] ? { sensitive: true } : {}) })) })
}

export async function putItem(app: App, userId: string, event: LambdaEvent, orgId: string, collectionId: string, itemId: string): Promise<LambdaResponse> {
  const { c } = await requireAccess(app, orgId, collectionId, userId, 'edit')
  if (!isValidId(itemId)) throw badRequest('item id must be an identifier.')
  const b = body(event)
  const blob = requireSealed(b['blob'], 'blob')
  // Items are written under the current key version only, so a member who
  // still holds a rotated-away key cannot add anything readable to it.
  if (b['keyVersion'] !== c.keyVersion) throw new HttpError(409, 'conflict', 'The collection key changed; reload and try again.')
  const existing = await app.store.get(collectionItemsPk(orgId, collectionId), itemSk(itemId))
  const at = now(app)
  await app.store.put({ pk: collectionItemsPk(orgId, collectionId), sk: itemSk(itemId), id: itemId, blob, keyVersion: c.keyVersion, createdAt: existing?.['createdAt'] ?? at, updatedAt: at, updatedBy: userId, ...(existing?.['sensitive'] ? { sensitive: true } : {}) })
  // A changed password clears the "someone who left could have seen it" mark.
  if (b['passwordChanged'] === true) await app.store.delete(orgPk(orgId), staleSk(collectionId, itemId))
  await orgEvent(app, orgId, userId, existing ? 'item.edit' : 'item.create', { collectionId, itemId })
  return json(200, { id: itemId })
}

export async function deleteItem(app: App, userId: string, orgId: string, collectionId: string, itemId: string): Promise<LambdaResponse> {
  await requireAccess(app, orgId, collectionId, userId, 'edit')
  if (!isValidId(itemId)) throw notFound()
  await app.store.delete(collectionItemsPk(orgId, collectionId), itemSk(itemId))
  await app.store.delete(orgPk(orgId), staleSk(collectionId, itemId))
  await orgEvent(app, orgId, userId, 'item.delete', { collectionId, itemId })
  return json(200, { ok: true })
}
