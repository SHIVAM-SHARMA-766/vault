// The operator's routes. Everything here manages accounts and the service; none
// of it can read a vault. The server holds no key for entry content and stores
// addresses only as digests, so the most an admin can learn about an account is
// when it was created, when it last signed in, and how many items it holds.
//
// Access is by account and role: owners are the addresses in ADMIN_EMAILS, and
// owners grant admin, marketing and viewer to other accounts. Each route names
// the permission it needs; roles.ts maps roles to permissions. See
// decisions/0006-admin-panel.md and 0007-roles-and-site-editing.md.

import { emailDigest } from '../identity.js'
import { featuresOf } from '../edition.js'
import type { App } from '../context.js'
import { HttpError, type LambdaEvent, type LambdaResponse, badRequest, forbidden, json, notFound, parseJsonBody } from '../http.js'
import { type TemplateKind, TEMPLATE_KINDS, accountResetMessage, applyTemplate, inviteMessage, notify, signInNotice, vaultApprovedMessage, verifyMessage } from '../mail.js'
import { clearPassword } from './accounts.js'
import { openEmail } from '../identity.js'
import { openTicketCount } from './desk.js'
import { leaveAllOrgs, purgeOrg } from './orgs.js'
import { requireEmail } from '../validate.js'
import {
  BACKUP_REQUEST_SK,
  BACKUP_SK,
  EMAIL_SK,
  ENTRY_PREFIX,
  FOLDER_PREFIX,
  PROFILE_SK,
  SESSION_PREFIX,
  SYSTEM_PK,
  USER_ORG_PREFIX,
  emailPk,
  isValidId,
  registrySk,
  userPk,
} from '../keys.js'
import { bkdueSk } from '../personal-backup.js'
import { updateStatus } from '../updates.js'
import { applyRetention } from '../retention.js'
import { eraseShares } from './shares.js'
import { allowedFrom, requireNetworks } from '../networks.js'
import { backupsEnabled } from '../backup.js'
import { BREACH_LIMIT } from '../breach.js'
import { PUBLIC_LIMIT } from './desk.js'
import { RUN_LIMIT } from './backups.js'
import { CREATE_LIMIT, OPEN_LIMIT } from './shares.js'
import { API_LIMIT, AUTH_LIMIT, SSO_LIMIT, enforce, type Limit } from '../ratelimit.js'
import {
  GRANTABLE_ROLES,
  type GrantableRole,
  type Permission,
  type Role,
  can,
  outranks,
  requirePermission,
  roleFromDigest,
} from '../roles.js'
import {
  REGISTRATION_MODES,
  type InstanceProfile,
  type RegistrationMode,
  type RegistryEntry,
  type RegistryFields,
  audit,
  createInvite,
  deleteInvite,
  getRegistry,
  getSettings,
  listAudit,
  listInvites,
  listRegistry,
  putRegistry,
  putSettings,
  ACCENTS,
  LOGO_MAX_CHARS,
  LOGO_PATTERN,
  POLICY_CHOICES,
  type ServerPolicy,
  type Settings,
  readPolicy,
  serverPolicyGap,
} from '../system.js'
import { revokeAllSessions } from './auth.js'
import { hasSecondFactor } from '../twofactor.js'

const ADMIN_LIMIT: Limit = { max: 300, windowSeconds: 15 * 60 }

/** The check every admin route makes: the caller's current role, re-read from
 *  the profile and registry, must carry the permission. */
export async function guard(app: App, userId: string, permission: Permission): Promise<Role> {
  const role = await requirePermission(app, userId, permission)
  await enforce(app.store, 'admin', userId, ADMIN_LIMIT, app.now())
  // Staff must have two-factor sign-in, when the policy says so (phase 3).
  // Turning it on in Settings → Security is not an admin route, so nobody is
  // locked out of fixing it.
  if ((await getSettings(app)).policy.requireStaffTwoFactor && !hasSecondFactor(await app.store.get(userPk(userId), PROFILE_SK))) {
    throw new HttpError(403, 'staff_two_factor_required', 'This server requires staff to use two-factor sign-in. Turn it on in Settings → Security, then come back.')
  }
  return role
}

/** Tells the other owners and admins about a change to who runs this server
 *  or how (phase 3): a role, a policy, registration, a deleted account. Best
 *  effort, after the change; the audit log is the record. */
export async function alertStaff(app: App, actor: string, what: string): Promise<void> {
  if (!app.mailer) return
  try {
    const registry = await listRegistry(app)
    const by = registry.find((r) => r.userId === actor)
    const who = (by && (emailOf(app, by) ?? by.label)) || 'An administrator'
    const { profile } = await getSettings(app)
    const name = profile.name || 'Vault'
    const text = `${who} ${what} on ${name} (${app.config.origin}) at ${new Date(app.now()).toUTCString()}.\n\nIf you did not expect this, check Admin console → Audit log, and the account that did it.\n\nSent to every owner and admin of this server.`
    for (const r of registry) {
      if (r.userId === actor || r.disabled) continue
      const role = roleFromDigest(app, r.emailDigest, r.role)
      if (role !== 'owner' && role !== 'admin') continue
      const to = emailOf(app, r)
      if (to) void notify(app, { to, subject: `${name}: ${what}`, text })
    }
  } catch { /* the audit log has it */ }
}

interface UserSummary {
  userId: string
  email: string | null
  label: string | null
  createdAt: string
  lastLoginAt: string | null
  disabled: boolean
  isAdmin: boolean
  role: Role
  twoFactor: boolean
  /** Misses the server policy (two-factor or password strength). */
  policyGap: boolean
}

/** One row of the users list: the registry entry and the profile, two reads.
 *  Counting items and sessions reads a whole vault, so that waits for the
 *  person's own page (userDetail). */
async function summarize(app: App, reg: RegistryEntry, policy: ServerPolicy): Promise<UserSummary> {
  const profile = await app.store.get(userPk(reg.userId), PROFILE_SK)
  return {
    userId: reg.userId,
    // The username (decisions/0037); null for an account not signed in since.
    email: emailOf(app, reg),
    label: reg.label ?? null,
    createdAt: reg.createdAt,
    lastLoginAt: reg.lastLoginAt ?? null,
    disabled: reg.disabled === true,
    isAdmin: app.adminDigests.has(reg.emailDigest),
    role: roleFromDigest(app, reg.emailDigest, reg.role),
    twoFactor: hasSecondFactor(profile),
    policyGap: serverPolicyGap(policy, profile ?? null) !== null,
  }
}

/** Not signed in for this long: "inactive" in the list and the overview. */
export const INACTIVE_DAYS = 90

/** Counts that read every vault (items and sessions): kept for a few
 *  minutes, so opening the overview is cheap. Policy and two-factor counts
 *  read only each profile and are always current. */
const HEAVY_TTL_MS = 5 * 60_000
const heavyCache = new WeakMap<App, { at: number; value: Promise<HeavyStats> }>()
interface HeavyStats { entries: number; activeSessions: number }

async function heavyStats(app: App, registry: RegistryEntry[]): Promise<HeavyStats> {
  const hit = heavyCache.get(app)
  if (hit && app.now() - hit.at < HEAVY_TTL_MS) return hit.value
  const value = (async () => {
    const now = Math.floor(app.now() / 1000)
    let entries = 0, activeSessions = 0
    for (const reg of registry) {
      const items = await app.store.query(userPk(reg.userId))
      entries += items.filter((i) => i.sk.startsWith(ENTRY_PREFIX)).length
      activeSessions += items.filter((i) => i.sk.startsWith(SESSION_PREFIX) && (typeof i['expiresAt'] !== 'number' || i['expiresAt'] > now)).length
    }
    return { entries, activeSessions }
  })()
  heavyCache.set(app, { at: app.now(), value })
  value.catch(() => heavyCache.delete(app))
  return value
}

async function profileStats(app: App, registry: RegistryEntry[], policy: ServerPolicy) {
  let twoFactorUsers = 0, policyGapUsers = 0
  await Promise.all(registry.filter((r) => !r.disabled).map(async (r) => {
    const profile = await app.store.get(userPk(r.userId), PROFILE_SK)
    if (hasSecondFactor(profile)) twoFactorUsers++
    if (serverPolicyGap(policy, profile ?? null) !== null) policyGapUsers++
  }))
  return { twoFactorUsers, policyGapUsers }
}

/** After an action that changes those counts, the next overview recounts. */
export function forgetHeavyStats(app: App): void { heavyCache.delete(app) }

const inactiveSince = (app: App) => app.now() - INACTIVE_DAYS * 86_400_000

export async function overview(app: App): Promise<LambdaResponse> {
  const [registry, settings, invites, backup] = await Promise.all([
    listRegistry(app),
    getSettings(app),
    listInvites(app),
    app.store.get(SYSTEM_PK, BACKUP_SK),
  ])
  const [heavy, prof] = await Promise.all([heavyStats(app, registry), profileStats(app, registry, settings.policy)])
  const now = app.now()
  const since = inactiveSince(app)
  const active = registry.filter((r) => !r.disabled)
  return json(200, {
    users: registry.length,
    disabledUsers: registry.length - active.length,
    policyGapUsers: prof.policyGapUsers,
    twoFactorUsers: prof.twoFactorUsers,
    inactiveUsers: active.filter((r) => !r.lastLoginAt || Date.parse(r.lastLoginAt) < since).length,
    entries: heavy.entries,
    activeSessions: heavy.activeSessions,
    activeInvites: invites.filter((i) => !i.usedAt && Date.parse(i.expiresAt) > now).length,
    registration: settings.registration,
    registrationForcedOpen: app.allowRegistration,
    lastBackup: backup
      ? { at: backup['at'] ?? null, object: backup['object'] ?? null, bytes: backup['bytes'] ?? null }
      : null,
    mail: !!app.mailer,
    openTickets: await openTicketCount(app),
    serverTime: new Date(now).toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    version: app.config.version,
  })
}

/** Sends a test message, so an operator can check the SMTP settings. */
export async function testMail(app: App, actor: string, event: LambdaEvent): Promise<LambdaResponse> {
  if (!app.mailer) throw new HttpError(503, 'unavailable', 'Mail is not set up on this server (SMTP_HOST).')
  const to = requireEmail(parseJsonBody<{ to?: unknown }>(event).to)
  await audit(app, actor, 'mail.test')
  try {
    await app.mailer.send({ to, subject: 'Vault test message', text: `This is a test message from the Vault server at ${app.config.origin}. Mail is working.` })
  } catch (err) {
    throw new HttpError(400, 'bad_request', `The mail server refused it: ${(err as Error).message}`)
  }
  return json(200, { sent: true })
}

export async function deleteOrgAsOperator(app: App, actor: string, orgId: string): Promise<LambdaResponse> {
  if (!isValidId(orgId)) throw notFound()
  const meta = await app.store.get(`ORG#${orgId}`, 'META')
  if (!meta) throw notFound()
  await audit(app, actor, 'org.delete', orgId, String(meta['hint'] ?? ''))
  await purgeOrg(app, orgId)
  return json(200, { ok: true })
}

const USER_SORTS = ['created', 'lastLogin', 'email'] as const
const USER_STATUSES = ['active', 'disabled', 'inactive', 'never'] as const

/** The users list (Phase 1 of the admin console): searched, filtered, sorted
 *  and paged on the server, so a server with thousands of accounts sends one
 *  page. Query: q, role, status, twoFactor (on|off), sort, dir, offset, limit. */
export async function listUsers(app: App, event: LambdaEvent): Promise<LambdaResponse> {
  const q = Object.fromEntries(new URLSearchParams(event.rawQueryString ?? '')) as Record<string, string>
  const text = (q['q'] ?? '').trim().toLowerCase().slice(0, 200)
  const role = q['role'] ?? ''
  const status = (USER_STATUSES as readonly string[]).includes(q['status'] ?? '') ? q['status']! : ''
  const twoFactor = q['twoFactor'] === 'on' || q['twoFactor'] === 'off' ? q['twoFactor'] : ''
  const sort = (USER_SORTS as readonly string[]).includes(q['sort'] ?? '') ? q['sort']! : 'created'
  const dir = q['dir'] === 'asc' ? 1 : -1
  const offset = Math.max(0, Math.floor(Number(q['offset'] ?? 0)) || 0)
  const limit = Math.min(200, Math.max(1, Math.floor(Number(q['limit'] ?? 50)) || 50))

  const [registry, { policy }] = await Promise.all([listRegistry(app), getSettings(app)])
  const since = inactiveSince(app)
  const inactive = (r: RegistryEntry) => !r.disabled && (!r.lastLoginAt || Date.parse(r.lastLoginAt) < since)
  const counts = {
    all: registry.length,
    active: registry.filter((r) => !r.disabled).length,
    disabled: registry.filter((r) => r.disabled).length,
    inactive: registry.filter(inactive).length,
    never: registry.filter((r) => !r.lastLoginAt).length,
  }
  const rows = registry.map((r) => ({ r, email: emailOf(app, r), role: roleFromDigest(app, r.emailDigest, r.role) }))
  let matched = rows.filter(({ r, email, role: rr }) => {
    if (text && !(email ?? '').toLowerCase().includes(text) && !(r.label ?? '').toLowerCase().includes(text) && !r.userId.startsWith(text)) return false
    if (role && rr !== role) return false
    if (status === 'active' && r.disabled) return false
    if (status === 'disabled' && !r.disabled) return false
    if (status === 'inactive' && !inactive(r)) return false
    if (status === 'never' && r.lastLoginAt) return false
    return true
  })
  const key = (x: (typeof rows)[number]) => sort === 'email' ? (x.email ?? x.r.label ?? '~').toLowerCase() : sort === 'lastLogin' ? x.r.lastLoginAt ?? '' : x.r.createdAt
  matched.sort((a, b) => dir * key(a).localeCompare(key(b)) || a.r.userId.localeCompare(b.r.userId))

  // Two-factor lives in each profile: a filter on it reads the matched
  // profiles (one read each), a page reads only its own.
  let users: UserSummary[]
  let total: number
  if (twoFactor) {
    const all = await Promise.all(matched.map((x) => summarize(app, x.r, policy)))
    const kept = all.filter((u) => u.twoFactor === (twoFactor === 'on'))
    total = kept.length
    users = kept.slice(offset, offset + limit)
  } else {
    total = matched.length
    users = await Promise.all(matched.slice(offset, offset + limit).map((x) => summarize(app, x.r, policy)))
  }
  return json(200, { users, total, offset, limit, counts })
}

/** One account in full, for its page in the console: the row, what its vault
 *  holds (by count), its devices, its organizations and the staff actions
 *  that touched it. */
export async function userDetail(app: App, id: string): Promise<LambdaResponse> {
  if (!isValidId(id)) throw badRequest('Invalid user id.')
  const reg = await getRegistry(app, id)
  if (!reg) throw notFound()
  const { policy } = await getSettings(app)
  const items = await app.store.query(userPk(id))
  const profile = items.find((i) => i.sk === PROFILE_SK)
  const now = Math.floor(app.now() / 1000)
  const sessions = items.filter((i) => i.sk.startsWith(SESSION_PREFIX) && (typeof i['expiresAt'] !== 'number' || i['expiresAt'] > now))
    .map((r) => ({ device: String(r['name'] ?? r['device'] ?? 'Unknown device'), ip: String(r['ip'] ?? ''), createdAt: String(r['createdAt'] ?? ''), lastUsedAt: String(r['lastUsedAt'] ?? r['createdAt'] ?? '') }))
    .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
  const orgs = []
  for (const ref of items.filter((i) => i.sk.startsWith(USER_ORG_PREFIX))) {
    const orgId = String(ref['orgId'] ?? '')
    if (!isValidId(orgId)) continue
    const [meta, m] = await Promise.all([app.store.get(`ORG#${orgId}`, 'META'), app.store.get(`ORG#${orgId}`, `MEMBER#${id}`)])
    if (!meta || !m) continue
    orgs.push({ orgId, name: String(meta['hint'] ?? ''), role: String(m['role'] ?? 'member'), kind: String(meta['kind'] ?? 'team') })
  }
  const labels = new Map((await listRegistry(app)).map((r) => [r.userId, r.label ?? emailOf(app, r)]))
  const activity = (await listAudit(app, 2000)).filter((r) => r.target === id || r.actor === id).slice(0, 25)
    .map((r) => ({ at: r.at, action: r.action, actor: r.actor, actorLabel: labels.get(r.actor) ?? null, detail: r.detail ?? null }))
  return json(200, {
    user: await summarize(app, reg, policy),
    entries: items.filter((i) => i.sk.startsWith(ENTRY_PREFIX)).length,
    folders: items.filter((i) => i.sk.startsWith(FOLDER_PREFIX)).length,
    accountPassword: !!profile?.['account'],
    sessions,
    orgs,
    activity,
  })
}

const BULK_ACTIONS = ['disable', 'enable', 'signout', 'reset-2fa'] as const
type BulkAction = (typeof BULK_ACTIONS)[number]

/** One action on many accounts (at most 200): each is checked and recorded
 *  as if done alone, and the answer says which ones failed and why. */
export async function bulkUsers(app: App, actor: string, actorRole: Role, event: LambdaEvent): Promise<LambdaResponse> {
  const body = parseJsonBody<{ ids?: unknown; action?: unknown }>(event)
  if (!(BULK_ACTIONS as readonly unknown[]).includes(body.action)) throw badRequest(`action must be one of: ${BULK_ACTIONS.join(', ')}.`)
  if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > 200 || !body.ids.every((x) => typeof x === 'string')) {
    throw badRequest('ids must be a list of 1 to 200 account ids.')
  }
  const action = body.action as BulkAction
  const results: { id: string; ok: boolean; error?: string }[] = []
  for (const id of new Set(body.ids as string[])) {
    try {
      if (action === 'disable' || action === 'enable') {
        const reg = await targetUser(app, actor, actorRole, id, false)
        if ((action === 'disable') !== (reg.disabled === true)) {
          await audit(app, actor, action === 'disable' ? 'user.disable' : 'user.enable', id, 'bulk')
          await putRegistry(app, { ...fieldsOf(reg), disabled: action === 'disable' })
          if (action === 'disable') await revokeAllSessions(app, id)
        }
      } else if (action === 'signout') {
        await targetUser(app, actor, actorRole, id, false)
        await audit(app, actor, 'user.revoke-sessions', id, 'bulk')
        await revokeAllSessions(app, id)
      } else {
        await resetTwoFactor(app, actor, actorRole, id)
      }
      results.push({ id, ok: true })
    } catch (err) {
      results.push({ id, ok: false, error: err instanceof HttpError ? err.message : 'Could not be done.' })
    }
  }
  forgetHeavyStats(app)
  return json(200, { results, done: results.filter((r) => r.ok).length })
}

function fieldsOf(reg: RegistryEntry): RegistryFields {
  return {
    userId: reg.userId,
    emailDigest: reg.emailDigest,
    createdAt: reg.createdAt,
    ...(reg.lastLoginAt ? { lastLoginAt: reg.lastLoginAt } : {}),
    ...(reg.label ? { label: reg.label } : {}),
    ...(reg.disabled ? { disabled: true } : {}),
    ...(reg.inviteId ? { inviteId: reg.inviteId } : {}),
    ...(reg.role ? { role: reg.role } : {}),
    ...(reg.emailSealed ? { emailSealed: reg.emailSealed } : {}),
    // Kept through a label, role or status change: dropping it would take a
    // company admin's right to create their company away (decisions/0033).
    ...(reg.companyGrant ? { companyGrant: true } : {}),
  }
}

/** A registry entry's address, opened for staff; null when not kept. */
export function emailOf(app: App, reg: RegistryEntry): string | null {
  if (!reg.emailSealed) return null
  try { return openEmail(app.config.pepper, reg.emailSealed) } catch { return null }
}

/** Loads the account an action targets and checks the actor may touch it: not
 *  themselves unless the action allows it, and never an account of equal or
 *  higher rank — an admin cannot act on another admin or an owner. */
async function targetUser(app: App, actor: string, actorRole: Role, id: string, allowSelf: boolean) {
  if (!isValidId(id)) throw badRequest('Invalid user id.')
  const self = id === actor
  if (!allowSelf && self) throw badRequest('That cannot be done to your own account.')
  const reg = await getRegistry(app, id)
  if (!reg) throw notFound()
  if (!self && !outranks(actorRole, roleFromDigest(app, reg.emailDigest, reg.role))) throw forbidden()
  return reg
}

export async function setRole(app: App, actor: string, actorRole: Role, event: LambdaEvent, id: string): Promise<LambdaResponse> {
  const reg = await targetUser(app, actor, actorRole, id, false)
  if (app.adminDigests.has(reg.emailDigest)) throw badRequest('Owners are set in the host configuration, not here.')
  const body = parseJsonBody<{ role?: unknown }>(event)
  if (!(GRANTABLE_ROLES as readonly unknown[]).includes(body.role)) {
    throw badRequest(`role must be one of: ${GRANTABLE_ROLES.join(', ')}.`)
  }
  const role = body.role as GrantableRole
  await audit(app, actor, 'user.role', id, role)
  const { role: _old, ...rest } = fieldsOf(reg)
  await putRegistry(app, { ...rest, ...(role !== 'user' ? { role } : {}) })
  void alertStaff(app, actor, `made ${emailOf(app, reg) ?? reg.label ?? 'an account'} ${role === 'user' ? 'a plain user' : `${/^[aeiou]/.test(role) ? 'an' : 'a'} ${role}`}`)
  return json(200, { ok: true })
}

export async function setLabel(app: App, actor: string, actorRole: Role, event: LambdaEvent, id: string): Promise<LambdaResponse> {
  const reg = await targetUser(app, actor, actorRole, id, true)
  const body = parseJsonBody<{ label?: unknown }>(event)
  if (typeof body.label !== 'string' || body.label.length > 80) throw badRequest('label must be a string of at most 80 characters.')
  const label = body.label.trim()
  await audit(app, actor, 'user.label', id, label)
  const { label: _old, ...rest } = fieldsOf(reg)
  await putRegistry(app, { ...rest, ...(label ? { label } : {}) })
  return json(200, { ok: true })
}

export async function setDisabled(app: App, actor: string, actorRole: Role, event: LambdaEvent, id: string): Promise<LambdaResponse> {
  const reg = await targetUser(app, actor, actorRole, id, false)
  const body = parseJsonBody<{ disabled?: unknown }>(event)
  if (typeof body.disabled !== 'boolean') throw badRequest('disabled must be true or false.')
  await audit(app, actor, body.disabled ? 'user.disable' : 'user.enable', id)
  await putRegistry(app, { ...fieldsOf(reg), disabled: body.disabled })
  if (body.disabled) await revokeAllSessions(app, id)
  return json(200, { ok: true })
}

/** Someone leaves (B9): in one step, the account is disabled, signed out
 *  everywhere, and taken out of every organization — which marks each
 *  collection they could open for rotation and lists its passwords to
 *  change. Refused while they own an organization. Reversible: enable the
 *  account again; organizations re-invite. */
export async function offboard(app: App, actor: string, actorRole: Role, id: string): Promise<LambdaResponse> {
  const reg = await targetUser(app, actor, actorRole, id, false)
  const { owned } = await leaveAllOrgs(app, id, true)
  if (owned.length) throw new HttpError(409, 'conflict', `They own ${owned.length === 1 ? 'an organization' : `${owned.length} organizations`} (${owned.join(', ')}). Transfer or delete ${owned.length === 1 ? 'it' : 'them'} first.`)
  await audit(app, actor, 'user.offboard', id)
  await putRegistry(app, { ...fieldsOf(reg), disabled: true })
  await revokeAllSessions(app, id)
  await leaveAllOrgs(app, id, false)
  return json(200, { ok: true })
}

export async function revokeSessions(app: App, actor: string, actorRole: Role, id: string): Promise<LambdaResponse> {
  await targetUser(app, actor, actorRole, id, true)
  await audit(app, actor, 'user.revoke-sessions', id)
  await revokeAllSessions(app, id)
  return json(200, { ok: true })
}

/** Turns off someone's two-factor sign-in, for the person who lost both their
 *  phone and their recovery codes. Audited; they can turn it on again. */
export async function resetTwoFactor(app: App, actor: string, actorRole: Role, id: string): Promise<LambdaResponse> {
  await targetUser(app, actor, actorRole, id, false)
  const profile = await app.store.get(userPk(id), PROFILE_SK)
  if (!profile) throw notFound()
  await audit(app, actor, 'user.reset-2fa', id)
  const { totp: _t, recoveryCodes: _r, pendingTotp: _p, webauthn: _w, pendingWebauthn: _pw, webauthnLogin: _wl, ...rest } = profile
  await app.store.put(rest as typeof profile)
  return json(200, { ok: true })
}

/** Clears someone's account password (decisions/0036), when they forgot it
 *  and the server has no mail. They sign in once with the master password
 *  and choose a new one; their account sign-ins end. */
export async function resetAccountPassword(app: App, actor: string, actorRole: Role, id: string): Promise<LambdaResponse> {
  await targetUser(app, actor, actorRole, id, false)
  await audit(app, actor, 'user.reset-account-password', id)
  await clearPassword(app, id)
  return json(200, { ok: true })
}

/** The same, from the server's own host, by address: for the only admin of a
 *  personal Vault (decisions/0030), who has nobody to ask. Access to the host
 *  is the proof of ownership. Audited as done from the host. */
export async function resetTwoFactorFromHost(app: App, email: string): Promise<string> {
  const pointer = await app.store.get(emailPk(emailDigest(email, app.config.pepper)), EMAIL_SK)
  const userId = typeof pointer?.['userId'] === 'string' ? pointer['userId'] : null
  const profile = userId ? await app.store.get(userPk(userId), PROFILE_SK) : null
  if (!userId || !profile) throw new Error(`no account for ${email}`)
  await audit(app, 'host', 'user.reset-2fa', userId, 'from the server host')
  const { totp: _t, recoveryCodes: _r, pendingTotp: _p, webauthn: _w, pendingWebauthn: _pw, webauthnLogin: _wl, ...rest } = profile
  await app.store.put(rest as typeof profile)
  return userId
}

/** Removes an account and everything in it. There is no undo: the entries
 *  were readable only by their owner, and the daily export is the only copy. */
export async function deleteUser(app: App, actor: string, actorRole: Role, event: LambdaEvent, id: string): Promise<LambdaResponse> {
  const reg = await targetUser(app, actor, actorRole, id, false)
  const body = parseJsonBody<{ confirm?: unknown }>(event)
  if (body.confirm !== id) throw badRequest('Send the user id as "confirm" to delete an account.')
  const { owned } = await leaveAllOrgs(app, id, true)
  if (owned.length) throw new HttpError(409, 'conflict', `This account owns ${owned.length} organization(s) (${owned.join(', ')}). Delete them first under Organizations.`)
  await audit(app, actor, 'user.delete', id, reg.label)
  const gone = emailOf(app, reg) ?? reg.label ?? 'an account'
  await eraseAccount(app, id, reg.emailDigest)
  void alertStaff(app, actor, `deleted the account ${gone}`)
  return json(200, { ok: true })
}

/** Removes an account and everything it holds: its partition (vault,
 *  history, sessions, preferences, backups), its address pointer, its place
 *  in the registry, and its backup schedule; it leaves its organizations.
 *  The caller has already refused when it owns any. */
export async function eraseAccount(app: App, id: string, emailDigest: string): Promise<void> {
  await leaveAllOrgs(app, id, false)
  await eraseShares(app, id)
  for (const item of await app.store.query(userPk(id))) await app.store.delete(item.pk, item.sk)
  await app.store.delete(emailPk(emailDigest), EMAIL_SK)
  await app.store.delete(SYSTEM_PK, registrySk(id))
  await app.store.delete(SYSTEM_PK, bkdueSk(id))
}

export async function getSettingsRoute(app: App): Promise<LambdaResponse> {
  return json(200, { ...(await getSettings(app)), registrationForcedOpen: app.allowRegistration })
}

export async function putSettingsRoute(app: App, actor: string, event: LambdaEvent): Promise<LambdaResponse> {
  const body = parseJsonBody<{ registration?: unknown; profile?: unknown; policy?: unknown; templates?: unknown }>(event)
  if (body.registration === undefined && body.profile === undefined && body.policy === undefined && body.templates === undefined) {
    throw badRequest('Send registration, profile, policy or templates.')
  }
  const current = await getSettings(app)
  let registration = current.registration
  if (body.registration !== undefined) {
    if (!featuresOf(app.config.edition).invitations) throw badRequest('A personal Vault has one account; there is no registration to change.')
    if (!REGISTRATION_MODES.includes(body.registration as RegistrationMode)) {
      throw badRequest(`registration must be one of: ${REGISTRATION_MODES.join(', ')}.`)
    }
    registration = body.registration as RegistrationMode
    await audit(app, actor, 'settings.registration', undefined, registration)
  }
  let profile = current.profile
  if (body.profile !== undefined) {
    profile = requireProfile(body.profile)
    await audit(app, actor, 'settings.profile', undefined, profile.supportEmail || undefined)
  }
  let policy = current.policy
  if (body.policy !== undefined) {
    policy = requirePolicy(body.policy)
    // A list that shuts out the person saving it would lock them out at their next refresh.
    const ip = event.requestContext.http.sourceIp
    if (!allowedFrom(policy.allowedNetworks, ip)) throw badRequest(`Your own address (${ip}) is not in the sign-in list. Add it first, or you would be signed out.`)
    if (policy.requireSso && !app.config.oidc) throw badRequest('Single sign-on is not set up on this server (OIDC_ISSUER), so it cannot be required.')
    if (policy.requireStaffTwoFactor && !current.policy.requireStaffTwoFactor && !hasSecondFactor(await app.store.get(userPk(actor), PROFILE_SK))) {
      throw badRequest('Turn on two-factor sign-in for your own account first (Settings → Security), or this policy would shut you out of the admin console.')
    }
    await audit(app, actor, 'settings.policy', undefined, describePolicy(policy))
  }
  let templates = current.templates
  if (body.templates !== undefined) {
    templates = requireTemplates(body.templates)
    await audit(app, actor, 'settings.templates', undefined, Object.keys(templates).join(',') || 'defaults')
  }
  await putSettings(app, { registration, profile, policy, templates, updatedAt: new Date(app.now()).toISOString() })
  if (registration !== current.registration) void alertStaff(app, actor, `changed registration to "${registration}"`)
  if (body.policy !== undefined && describePolicy(policy) !== describePolicy(current.policy)) void alertStaff(app, actor, `changed the server policies (${describePolicy(policy)})`)
  // A shortened retention period takes effect now, not at the next pass.
  if (policy.activityDays < current.policy.activityDays || policy.auditDays < current.policy.auditDays) await applyRetention(app)
  return json(200, { ok: true })
}

/** The server policy, as an admin sends it: every field must be one of the
 *  offered choices, so a typo is refused rather than silently defaulted. */
export function requirePolicy(value: unknown): ServerPolicy {
  if (!value || typeof value !== 'object') throw badRequest('policy must be an object.')
  const v = value as Record<string, unknown>
  for (const k of ['requireTwoFactor', 'shareLinks']) if (typeof v[k] !== 'boolean') throw badRequest(`policy.${k} must be true or false.`)
  requireNetworks(v['allowedNetworks'] ?? [])
  for (const k of Object.keys(POLICY_CHOICES) as (keyof typeof POLICY_CHOICES)[]) {
    const choices = POLICY_CHOICES[k] as readonly unknown[]
    if (!choices.includes(v[k])) throw badRequest(`policy.${k} must be one of: ${choices.map((c) => c ?? 'null').join(', ')}.`)
  }
  for (const k of ['requireSso', 'weeklyDigest', 'requireStaffTwoFactor']) if (v[k] !== undefined && typeof v[k] !== 'boolean') throw badRequest(`policy.${k} must be true or false.`)
  return { ...readPolicy(v), allowedNetworks: requireNetworks(v['allowedNetworks'] ?? []) }
}

function describePolicy(p: ServerPolicy): string {
  return [
    p.requireTwoFactor ? '2fa' : null,
    p.minPasswordScore ? `score>=${p.minPasswordScore}` : null,
    p.maxIdleMinutes ? `lock<=${p.maxIdleMinutes}m` : null,
    p.sessionDays ? `session=${p.sessionDays}d` : null,
    `activity=${p.activityDays}d`,
    `audit=${p.auditDays}d`,
    p.shareLinks ? `links<=${p.shareLinkMaxDays}d` : 'no-links',
    p.allowedNetworks.length ? `networks=${p.allowedNetworks.join(',')}` : null,
    p.requireSso ? 'sso' : null,
    p.weeklyDigest ? null : 'no-digest',
    p.requireStaffTwoFactor ? 'staff-2fa' : null,
  ].filter(Boolean).join(' ')
}

/** The instance profile, as an admin sends it. Every field may be empty. */
export function requireProfile(value: unknown): InstanceProfile {
  if (!value || typeof value !== 'object') throw badRequest('profile must be an object.')
  const v = value as Record<string, unknown>
  const text = (k: string, max: number) => {
    const x = v[k] ?? ''
    if (typeof x !== 'string') throw badRequest(`profile.${k} must be text.`)
    const t = x.trim()
    if (t.length > max) throw badRequest(`profile.${k} must be at most ${max} characters.`)
    if (/[\u0000-\u001f<>]/.test(t)) throw badRequest(`profile.${k} contains characters that are not allowed.`)
    return t
  }
  const name = text('name', 60)
  const supportEmail = text('supportEmail', 254)
  if (supportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supportEmail)) throw badRequest('profile.supportEmail must be an email address.')
  const supportUrl = text('supportUrl', 300)
  if (supportUrl) {
    let ok = false
    try { const u = new URL(supportUrl); ok = u.protocol === 'https:' || u.protocol === 'http:' } catch { /* refused below */ }
    if (!ok) throw badRequest('profile.supportUrl must be an http(s) address.')
  }
  const accent = v['accent'] ?? ''
  if (typeof accent !== 'string' || (accent && !(ACCENTS as readonly string[]).includes(accent))) throw badRequest(`profile.accent must be one of: ${ACCENTS.join(', ')}, or empty.`)
  const logo = v['logo'] ?? ''
  if (typeof logo !== 'string' || logo.length > LOGO_MAX_CHARS || (logo && !LOGO_PATTERN.test(logo))) {
    throw badRequest(`profile.logo must be a PNG, JPEG or WebP image of at most ${Math.floor(LOGO_MAX_CHARS * 3 / 4 / 1024)} KB, or empty.`)
  }
  return { name, supportEmail, supportUrl, accent, logo }
}

/** Staff only: this version and whether a newer one is out. */
export async function updateRoute(app: App, event: LambdaEvent): Promise<LambdaResponse> {
  const force = new URLSearchParams(event.rawQueryString ?? '').get('refresh') === '1'
  return json(200, await updateStatus(app, { force }))
}

/** What anyone may know about this server before signing in. */
export async function instanceRoute(app: App): Promise<LambdaResponse> {
  const { registration, profile, policy } = await getSettings(app)
  const firstRun = (await listRegistry(app)).length === 0
  return json(200, {
    name: profile.name || 'Vault',
    supportEmail: profile.supportEmail,
    supportUrl: profile.supportUrl,
    accent: profile.accent,
    logo: profile.logo,
    // A personal Vault takes no registrations once its owner exists (decisions/0030).
    registration: !featuresOf(app.config.edition).invitations && !firstRun ? 'closed' : app.allowRegistration ? 'open' : registration,
    // What this server includes (decisions/0030); the clients shape themselves from it.
    edition: app.config.edition,
    features: featuresOf(app.config.edition),
    // Companies here are invited by the operator (decisions/0033).
    companiesInvited: app.config.hostedTenants,
    mail: Boolean(app.mailer),
    breachCheck: app.config.breachCheck.enabled,
    // The weakest master password this server accepts (0–4), so the sign-up
    // form can say so before anyone types one.
    minPasswordScore: policy.minPasswordScore,
    // A new server waiting for its owner: the sign-in screen offers the setup code.
    firstRun,
    // Single sign-on (decisions/0021): the button's label, and whether it is required.
    sso: app.config.oidc ? { name: app.config.oidc.name, required: policy.requireSso, provision: app.config.oidc.provision } : null,
  })
}

/** Invitations do not work while registration is closed; say so at the
 *  moment one is made, rather than when the invitee is refused. */
async function closedWarning(app: App): Promise<{ warning?: string }> {
  if (app.allowRegistration) return {}
  const { registration } = await getSettings(app)
  return registration === 'closed' ? { warning: 'Registration is closed, so these invitations will not work until you set it to Invite only (Overview → Registration).' } : {}
}

/** At most this many invitations in one request. */
export const BULK_INVITE_MAX = 100

/** Many invitations at once: a list of people (an address, and a name the
 *  admin will recognise), one role and one lifetime. Each address is used to
 *  send and dropped, as with a single invitation; without mail the codes come
 *  back for the admin to hand out. Validated whole before anything is made. */
export async function bulkInviteRoute(app: App, actor: string, actorRole: Role, event: LambdaEvent): Promise<LambdaResponse> {
  const body = parseJsonBody<{ people?: unknown; days?: unknown; role?: unknown }>(event)
  if (!Array.isArray(body.people) || body.people.length === 0) throw badRequest('people must be a non-empty list.')
  if (body.people.length > BULK_INVITE_MAX) throw badRequest(`At most ${BULK_INVITE_MAX} people at a time.`)
  const role = body.role === undefined ? 'user' : body.role
  if (!(GRANTABLE_ROLES as readonly unknown[]).includes(role)) throw badRequest(`role must be one of: ${GRANTABLE_ROLES.join(', ')}.`)
  if (role !== 'user' && !can(actorRole, 'roles.write')) throw forbidden()
  const days = body.days === undefined ? 7 : body.days
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 30) throw badRequest('days must be a whole number from 1 to 30.')

  const seen = new Set<string>()
  const people = body.people.map((p, i) => {
    const r = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>
    let email: string
    try { email = requireEmail(r['email']).trim().toLowerCase() } catch { throw badRequest(`Line ${i + 1}: not an email address.`) }
    if (seen.has(email)) throw badRequest(`Line ${i + 1}: ${email} is listed twice.`)
    seen.add(email)
    const name = typeof r['name'] === 'string' ? r['name'].trim() : ''
    if (name.length > 80) throw badRequest(`Line ${i + 1}: the name is longer than 80 characters.`)
    return { email, label: name || `Invitation ${i + 1}` }
  })

  await audit(app, actor, 'invite.bulk', undefined, `${people.length} (${role as string})`)
  const results = []
  for (const p of people) {
    const { code, invite } = await createInvite(app, actor, p.label, days, role as string)
    const emailed = await notify(app, { to: p.email, ...inviteMessage(app.config.origin, code, p.label, invite.expiresAt) })
    results.push({ email: p.email, label: p.label, emailed, expiresAt: invite.expiresAt, ...(emailed ? {} : { code }) })
  }
  return json(201, { results, mail: Boolean(app.mailer), ...(await closedWarning(app)) })
}

export async function listInvitesRoute(app: App): Promise<LambdaResponse> {
  const now = app.now()
  const invites = (await listInvites(app))
    .map((i) => ({
      id: i.id,
      label: i.label,
      createdAt: i.createdAt,
      expiresAt: i.expiresAt,
      usedAt: i.usedAt ?? null,
      usedBy: i.usedBy ?? null,
      role: i.role ?? 'user',
      ...(i.company ? { company: true } : {}),
      status: i.usedAt ? 'used' : Date.parse(i.expiresAt) <= now ? 'expired' : 'active',
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return json(200, { invites })
}

export async function createInviteRoute(app: App, actor: string, actorRole: Role, event: LambdaEvent): Promise<LambdaResponse> {
  const body = parseJsonBody<{ label?: unknown; days?: unknown; role?: unknown; email?: unknown }>(event)
  const email = body.email === undefined || body.email === '' ? '' : requireEmail(body.email)
  if (email && !app.mailer) throw new HttpError(503, 'unavailable', 'Mail is not set up on this server (SMTP_HOST). Copy the code and send it yourself.')
  const role = body.role === undefined ? 'user' : body.role
  if (!(GRANTABLE_ROLES as readonly unknown[]).includes(role)) {
    throw badRequest(`role must be one of: ${GRANTABLE_ROLES.join(', ')}.`)
  }
  // Inviting someone into a staff role is granting that role.
  if (role !== 'user' && !can(actorRole, 'roles.write')) throw forbidden()
  const label = typeof body.label === 'string' ? body.label.trim() : ''
  if (!label || label.length > 80) throw badRequest('label is required, at most 80 characters.')
  const days = body.days === undefined ? 7 : body.days
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 30) {
    throw badRequest('days must be a whole number from 1 to 30.')
  }
  await audit(app, actor, 'invite.create', undefined, role === 'user' ? label : `${label} (${role})`)
  const { code, invite } = await createInvite(app, actor, label, days, role as string)
  // The address is used to send and then dropped; only the label is kept.
  const emailed = email ? await notify(app, { to: email, ...inviteMessage(app.config.origin, code, label, invite.expiresAt) }) : false
  // The code is returned exactly once. Only its hash is stored.
  return json(201, { code, emailed, invite: { id: invite.id, label, expiresAt: invite.expiresAt, role }, ...(await closedWarning(app)) })
}

/** A company invitation (decisions/0033): on a hosted server, the code lets the
 *  person who signs up with it create one company, which they then run. */
export async function createCompanyInviteRoute(app: App, actor: string, event: LambdaEvent): Promise<LambdaResponse> {
  if (!app.config.hostedTenants) throw new HttpError(404, 'not_in_edition', 'Company invitations are for a hosted Vault (EDITION=hosted).')
  const body = parseJsonBody<{ label?: unknown; days?: unknown; email?: unknown }>(event)
  const email = body.email === undefined || body.email === '' ? '' : requireEmail(body.email)
  if (email && !app.mailer) throw new HttpError(503, 'unavailable', 'Mail is not set up on this server (SMTP_HOST). Copy the code and send it yourself.')
  const label = typeof body.label === 'string' ? body.label.trim() : ''
  if (!label || label.length > 80) throw badRequest('label (the company) is required, at most 80 characters.')
  const days = body.days === undefined ? 14 : body.days
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 30) throw badRequest('days must be a whole number from 1 to 30.')
  await audit(app, actor, 'invite.company', undefined, label)
  const { code, invite } = await createInvite(app, actor, label, days, 'user', { company: true })
  const emailed = email ? await notify(app, { to: email, ...inviteMessage(app.config.origin, code, label, invite.expiresAt) }) : false
  return json(201, { code, emailed, invite: { id: invite.id, label, expiresAt: invite.expiresAt, company: true } })
}

/** Sends an unused invitation again (B2). Codes are stored only as hashes,
 *  so the old one cannot be re-sent: a fresh code replaces it, with the same
 *  label and role and a new expiry, and the old one stops working. */
export async function resendInviteRoute(app: App, actor: string, actorRole: Role, event: LambdaEvent, id: string): Promise<LambdaResponse> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(id)) throw badRequest('Invalid invite id.')
  const old = (await listInvites(app)).find((i) => i.id === id)
  if (!old || old.usedAt) throw notFound()
  const role = old.role ?? 'user'
  if (role !== 'user' && !can(actorRole, 'roles.write')) throw forbidden()
  const b = parseJsonBody<{ email?: unknown; days?: unknown }>(event)
  const email = b.email === undefined || b.email === '' ? '' : requireEmail(b.email)
  if (email && !app.mailer) throw new HttpError(503, 'unavailable', 'Mail is not set up on this server (SMTP_HOST). Copy the new code and send it yourself.')
  const days = b.days === undefined ? 7 : b.days
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 30) throw badRequest('days must be a whole number from 1 to 30.')
  await audit(app, actor, 'invite.resend', id, old.label)
  const { code, invite } = await createInvite(app, actor, old.label, days, role)
  await deleteInvite(app, id)
  const emailed = email ? await notify(app, { to: email, ...inviteMessage(app.config.origin, code, old.label, invite.expiresAt) }) : false
  return json(201, { code, emailed, invite: { id: invite.id, label: old.label, expiresAt: invite.expiresAt, role }, ...(await closedWarning(app)) })
}

export async function deleteInviteRoute(app: App, actor: string, id: string): Promise<LambdaResponse> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(id)) throw badRequest('Invalid invite id.')
  await audit(app, actor, 'invite.delete', id)
  await deleteInvite(app, id)
  return json(200, { ok: true })
}

/** The staff audit log, filtered and paged on the server. Query: actor (an
 *  account id), action (a prefix such as "user." or "user.disable"), q (text
 *  in a label, address or detail), from and to (dates), offset, limit. */
export async function auditRoute(app: App, event?: LambdaEvent): Promise<LambdaResponse> {
  const q = Object.fromEntries(new URLSearchParams(event?.rawQueryString ?? '')) as Record<string, string>
  const actor = q['actor'] ?? ''
  const action = (q['action'] ?? '').slice(0, 60)
  const text = (q['q'] ?? '').trim().toLowerCase().slice(0, 200)
  const from = q['from'] && !Number.isNaN(Date.parse(q['from'])) ? new Date(q['from']).toISOString() : ''
  const to = q['to'] && !Number.isNaN(Date.parse(q['to'])) ? new Date(Date.parse(q['to']) + (q['to'].length <= 10 ? 86_400_000 : 0)).toISOString() : ''
  const offset = Math.max(0, Math.floor(Number(q['offset'] ?? 0)) || 0)
  const limit = Math.min(500, Math.max(1, Math.floor(Number(q['limit'] ?? 100)) || 100))
  // Ids mean nothing to a person reading the log; labels and addresses do.
  // Deleted accounts keep their id, and their label survives in the delete
  // record's detail.
  const labels = new Map((await listRegistry(app)).map((r) => [r.userId, r.label ?? emailOf(app, r)]))
  const all = (await listAudit(app, 100_000)).map((r) => ({
    at: r.at, actor: r.actor, action: r.action, target: r.target ?? null, detail: r.detail ?? null,
    actorLabel: labels.get(r.actor) ?? null,
    targetLabel: r.target ? labels.get(r.target) ?? null : null,
  }))
  const records = all.filter((r) => {
    if (actor && r.actor !== actor && r.target !== actor) return false
    if (action && !r.action.startsWith(action)) return false
    if (from && r.at < from) return false
    if (to && r.at >= to) return false
    if (text && ![r.actorLabel, r.targetLabel, r.detail, r.action].some((v) => (v ?? '').toLowerCase().includes(text))) return false
    return true
  })
  const actions = [...new Set(all.map((r) => r.action))].sort()
  return json(200, { records: records.slice(offset, offset + limit), total: records.length, offset, limit, actions })
}

// ── Server backups (C7) ─────────────────────────────────────────────────────
// Settings come from the host (BACKUP_*): they hold a passphrase and storage
// credentials, which do not belong in a database the backup itself contains.
// The panel shows them and can ask for a backup now. Routes never read every
// row (store.ts), so the request is recorded and the server's own backup loop,
// which can, takes it within a minute.

export async function backupStatus(app: App): Promise<LambdaResponse> {
  const b = app.config.backup
  const [last, request] = await Promise.all([app.store.get(SYSTEM_PK, BACKUP_SK), app.store.get(SYSTEM_PK, BACKUP_REQUEST_SK)])
  return json(200, {
    enabled: backupsEnabled(app.config),
    passphraseSet: Boolean(b.passphrase),
    intervalHours: b.intervalHours,
    keep: b.keep,
    destinations: [...(b.dir ? [{ kind: 'directory', where: b.dir }] : []), ...(b.s3 ? [{ kind: 's3', where: `${b.s3.bucket}/${b.s3.prefix}` }] : [])],
    last: last ? { at: last['at'], object: last['object'], bytes: last['bytes'] } : null,
    requestedAt: request?.['at'] ?? null,
    lastError: last?.['error'] ?? null,
  })
}

const BACKUP_NOW_LIMIT: Limit = { max: 4, windowSeconds: 3600 }

export async function requestBackup(app: App, actor: string): Promise<LambdaResponse> {
  if (!backupsEnabled(app.config)) throw new HttpError(503, 'unavailable', 'Backups are not set up on this server (BACKUP_PASSPHRASE and BACKUP_DIR or BACKUP_S3_*).')
  await enforce(app.store, 'backup-now', actor, BACKUP_NOW_LIMIT, app.now())
  await audit(app, actor, 'backup.request')
  const at = new Date(app.now()).toISOString()
  await app.store.put({ pk: SYSTEM_PK, sk: BACKUP_REQUEST_SK, at, by: actor })
  return json(202, { requestedAt: at })
}

// ── Rate limits (G5) ────────────────────────────────────────────────────────
// What the server allows, in words, so an admin can tell a person why they
// were asked to wait. Read-only: the values are part of the threat model.

export function limitsRoute(): LambdaResponse {
  const row = (name: string, per: string, l: Limit, note: string) => ({ name, per, max: l.max, windowSeconds: l.windowSeconds, note })
  return json(200, {
    limits: [
      row('Sign-in attempts', 'address and account', AUTH_LIMIT, 'Counted for each network address and for each account, separately.'),
      row('Sign-up codes and reset links', 'address', { max: 20, windowSeconds: 900 }, 'Also at most 5 to any one inbox in 15 minutes (decisions/0037).'),
      row('Single sign-on round trips', 'address', SSO_LIMIT, 'Going to the identity provider and back; the sign-in that follows counts as a sign-in attempt.'),
      row('Requests while signed in', 'account', API_LIMIT, 'Every vault, settings and sharing request.'),
      row('Admin panel requests', 'staff account', ADMIN_LIMIT, ''),
      row('Access and sign-in help requests', 'address', PUBLIC_LIMIT, 'The no-account forms on the sign-in page.'),
      row('Share links made', 'account', CREATE_LIMIT, ''),
      row('Share links opened', 'address', OPEN_LIMIT, 'Wrong or expired links count too.'),
      row('Personal backups run by hand, and test restores', 'account', RUN_LIMIT, 'Scheduled backups are not counted.'),
      row('Breach-check lookups', 'account', BREACH_LIMIT, 'One per distinct password prefix.'),
      row('Server backups asked for in the panel', 'staff account', BACKUP_NOW_LIMIT, ''),
    ],
  })
}

// ── Email templates (G6) ────────────────────────────────────────────────────

/** Admin-written subject and message per template; both plain text. A
 *  template with both fields empty is removed (the default returns). */
export function requireTemplates(value: unknown): Settings['templates'] {
  if (!value || typeof value !== 'object') throw badRequest('templates must be an object.')
  const v = value as Record<string, unknown>
  const out: Settings['templates'] = {}
  for (const [k, raw] of Object.entries(v)) {
    if (!(TEMPLATE_KINDS as readonly string[]).includes(k)) throw badRequest(`templates.${k} is not a template. Use: ${TEMPLATE_KINDS.join(', ')}.`)
    const t = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const subject = typeof t['subject'] === 'string' ? t['subject'].trim() : ''
    const message = typeof t['message'] === 'string' ? t['message'].replace(/\r\n/g, '\n').trim() : ''
    if (subject.length > 120 || /[\u0000-\u001f]/.test(subject)) throw badRequest(`templates.${k}.subject must be one line of at most 120 characters.`)
    if (message.length > 1000 || /[\u0000-\u0009\u000b-\u001f]/.test(message)) throw badRequest(`templates.${k}.message must be at most 1000 characters of plain text.`)
    if (subject || message) out[k as TemplateKind] = { subject, message }
  }
  return out
}

/** The message as recipients would get it, with sample details. */
export async function previewTemplate(app: App, event: LambdaEvent): Promise<LambdaResponse> {
  const b = parseJsonBody<{ kind?: unknown; subject?: unknown; message?: unknown }>(event)
  const kind = b.kind as TemplateKind
  if (!(TEMPLATE_KINDS as readonly unknown[]).includes(kind)) throw badRequest(`kind must be one of: ${TEMPLATE_KINDS.join(', ')}.`)
  const t = requireTemplates({ [kind]: { subject: b.subject ?? '', message: b.message ?? '' } })[kind]
  const { profile } = await getSettings(app)
  const o = app.config.origin
  const sample = kind === 'invite' ? inviteMessage(o, 'SAMPLE-CODE', 'Asha (finance)', new Date(app.now() + 7 * 86_400_000).toUTCString())
    : kind === 'verify' ? verifyMessage(o, '482913')
    : kind === 'vaultApproved' ? vaultApprovedMessage(o)
    : kind === 'accountReset' ? accountResetMessage(o, 'asha@example.com', 'SAMPLE-CODE')
    : signInNotice(o, 'Firefox on Windows', '203.0.113.7', new Date(app.now()).toUTCString(), false)
  const { template: _t, ...msg } = applyTemplate(sample, t, profile.name || 'Vault')
  return json(200, msg)
}

/** The audit log as a file (B7): `?format=csv` (default) or `json`, newest
 *  first, with the labels the panel shows. Every export is itself audited. */
export async function auditExport(app: App, event: LambdaEvent): Promise<LambdaResponse> {
  const format = new URLSearchParams(event.rawQueryString ?? '').get('format') === 'json' ? 'json' : 'csv'
  const labels = new Map((await listRegistry(app)).map((r) => [r.userId, r.label ?? '']))
  const rows = (await listAudit(app, 100_000)).map((r) => ({
    at: r.at, actor: r.actor, actorLabel: labels.get(r.actor) ?? '', action: r.action,
    target: r.target ?? '', targetLabel: r.target ? labels.get(r.target) ?? '' : '', detail: r.detail ?? '',
  }))
  const stamp = new Date(app.now()).toISOString().slice(0, 10)
  if (format === 'json') {
    return { statusCode: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="vault-audit-${stamp}.json"`, 'cache-control': 'no-store' }, body: JSON.stringify({ exportedAt: new Date(app.now()).toISOString(), records: rows }, null, 2) }
  }
  // Spreadsheet-safe: quoted, and a leading = + - @ is neutralised so a label
  // cannot become a formula when the file is opened.
  const cell = (v: string) => `"${(/^[=+\-@]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"`
  const head = ['at', 'actor', 'actorLabel', 'action', 'target', 'targetLabel', 'detail']
  const csv = [head.join(','), ...rows.map((r) => head.map((k) => cell(String(r[k as keyof typeof r]))).join(','))].join('\r\n')
  return { statusCode: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="vault-audit-${stamp}.csv"`, 'cache-control': 'no-store' }, body: csv }
}
