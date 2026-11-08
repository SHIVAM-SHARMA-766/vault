// The operator's routes. Everything here manages accounts and the service; none
// of it can read a vault. The server holds no key for entry content and stores
// addresses only as digests, so the most an admin can learn about an account is
// when it was created, when it last signed in, and how many items it holds.
//
// Access is by account and role: owners are the addresses in ADMIN_EMAILS, and
// owners grant admin, marketing and viewer to other accounts. Each route names
// the permission it needs; roles.ts maps roles to permissions. See
// decisions/0006-admin-panel.md and 0007-roles-and-site-editing.md.

import type { App } from '../context.js'
import { HttpError, type LambdaEvent, type LambdaResponse, badRequest, forbidden, json, notFound, parseJsonBody } from '../http.js'
import { type TemplateKind, TEMPLATE_KINDS, applyTemplate, inviteMessage, notify, signInNotice } from '../mail.js'
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
import { API_LIMIT, AUTH_LIMIT, enforce, type Limit } from '../ratelimit.js'
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
  POLICY_CHOICES,
  type ServerPolicy,
  type Settings,
  readPolicy,
  serverPolicyGap,
} from '../system.js'
import { revokeAllSessions } from './auth.js'

const ADMIN_LIMIT: Limit = { max: 300, windowSeconds: 15 * 60 }

/** The check every admin route makes: the caller's current role, re-read from
 *  the profile and registry, must carry the permission. */
export async function guard(app: App, userId: string, permission: Permission): Promise<Role> {
  const role = await requirePermission(app, userId, permission)
  await enforce(app.store, 'admin', userId, ADMIN_LIMIT, app.now())
  return role
}

interface UserSummary {
  userId: string
  label: string | null
  createdAt: string
  lastLoginAt: string | null
  disabled: boolean
  isAdmin: boolean
  role: Role
  twoFactor: boolean
  /** Misses the server policy (two-factor or password strength). */
  policyGap: boolean
  entries: number
  folders: number
  sessions: number
}

async function summarize(app: App, reg: RegistryEntry, policy: ServerPolicy): Promise<UserSummary> {
  const items = await app.store.query(userPk(reg.userId))
  const profile = items.find((i) => i.sk === PROFILE_SK)
  const now = Math.floor(app.now() / 1000)
  return {
    userId: reg.userId,
    label: reg.label ?? null,
    createdAt: reg.createdAt,
    lastLoginAt: reg.lastLoginAt ?? null,
    disabled: reg.disabled === true,
    isAdmin: app.adminDigests.has(reg.emailDigest),
    role: roleFromDigest(app, reg.emailDigest, reg.role),
    twoFactor: Boolean(profile?.['totp']),
    policyGap: serverPolicyGap(policy, profile ?? null) !== null,
    entries: items.filter((i) => i.sk.startsWith(ENTRY_PREFIX)).length,
    folders: items.filter((i) => i.sk.startsWith(FOLDER_PREFIX)).length,
    sessions: items.filter((i) => i.sk.startsWith(SESSION_PREFIX)
      && (typeof i['expiresAt'] !== 'number' || i['expiresAt'] > now)).length,
  }
}

export async function overview(app: App): Promise<LambdaResponse> {
  const [registry, settings, invites, backup] = await Promise.all([
    listRegistry(app),
    getSettings(app),
    listInvites(app),
    app.store.get(SYSTEM_PK, BACKUP_SK),
  ])
  const users = await Promise.all(registry.map((r) => summarize(app, r, settings.policy)))
  const now = app.now()
  return json(200, {
    users: users.length,
    disabledUsers: users.filter((u) => u.disabled).length,
    policyGapUsers: users.filter((u) => u.policyGap && !u.disabled).length,
    entries: users.reduce((n, u) => n + u.entries, 0),
    activeSessions: users.reduce((n, u) => n + u.sessions, 0),
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

export async function listUsers(app: App): Promise<LambdaResponse> {
  const [registry, { policy }] = await Promise.all([listRegistry(app), getSettings(app)])
  const users = await Promise.all(registry.map((r) => summarize(app, r, policy)))
  users.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return json(200, { users })
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
  }
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
  const { totp: _t, recoveryCodes: _r, pendingTotp: _p, ...rest } = profile
  await app.store.put(rest as typeof profile)
  return json(200, { ok: true })
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
  await eraseAccount(app, id, reg.emailDigest)
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
    await audit(app, actor, 'settings.policy', undefined, describePolicy(policy))
  }
  let templates = current.templates
  if (body.templates !== undefined) {
    templates = requireTemplates(body.templates)
    await audit(app, actor, 'settings.templates', undefined, Object.keys(templates).join(',') || 'defaults')
  }
  await putSettings(app, { registration, profile, policy, templates, updatedAt: new Date(app.now()).toISOString() })
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
  return { name, supportEmail, supportUrl }
}

/** Staff only: this version and whether a newer one is out. */
export async function updateRoute(app: App, event: LambdaEvent): Promise<LambdaResponse> {
  const force = new URLSearchParams(event.rawQueryString ?? '').get('refresh') === '1'
  return json(200, await updateStatus(app, { force }))
}

/** What anyone may know about this server before signing in. */
export async function instanceRoute(app: App): Promise<LambdaResponse> {
  const { registration, profile, policy } = await getSettings(app)
  return json(200, {
    name: profile.name || 'Vault',
    supportEmail: profile.supportEmail,
    supportUrl: profile.supportUrl,
    registration: app.allowRegistration ? 'open' : registration,
    mail: Boolean(app.mailer),
    breachCheck: app.config.breachCheck.enabled,
    // The weakest master password this server accepts (0–4), so the sign-up
    // form can say so before anyone types one.
    minPasswordScore: policy.minPasswordScore,
    // A new server waiting for its owner: the sign-in screen offers the setup code.
    firstRun: (await listRegistry(app)).length === 0,
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

export async function deleteInviteRoute(app: App, actor: string, id: string): Promise<LambdaResponse> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(id)) throw badRequest('Invalid invite id.')
  await audit(app, actor, 'invite.delete', id)
  await deleteInvite(app, id)
  return json(200, { ok: true })
}

export async function auditRoute(app: App): Promise<LambdaResponse> {
  // Ids mean nothing to a person reading the log; labels do. Deleted accounts
  // keep their id, and their label survives in the delete record's detail.
  const labels = new Map((await listRegistry(app)).map((r) => [r.userId, r.label ?? null]))
  const records = (await listAudit(app)).map((r) => ({
    at: r.at, actor: r.actor, action: r.action, target: r.target ?? null, detail: r.detail ?? null,
    actorLabel: labels.get(r.actor) ?? null,
    targetLabel: r.target ? labels.get(r.target) ?? null : null,
  }))
  return json(200, { records })
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
  const sample = kind === 'invite'
    ? inviteMessage(app.config.origin, 'SAMPLE-CODE', 'Asha (finance)', new Date(app.now() + 7 * 86_400_000).toUTCString())
    : signInNotice(app.config.origin, 'Firefox on Windows', '203.0.113.7', new Date(app.now()).toUTCString(), false)
  const { template: _t, ...msg } = applyTemplate(sample, t, profile.name || 'Vault')
  return json(200, msg)
}
