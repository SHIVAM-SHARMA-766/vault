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
import { inviteMessage, notify } from '../mail.js'
import { openTicketCount } from './desk.js'
import { leaveAllOrgs, purgeOrg } from './orgs.js'
import { requireEmail } from '../validate.js'
import {
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
import { enforce, type Limit } from '../ratelimit.js'
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
  entries: number
  folders: number
  sessions: number
}

async function summarize(app: App, reg: RegistryEntry): Promise<UserSummary> {
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
  const users = await Promise.all(registry.map((r) => summarize(app, r)))
  const now = app.now()
  return json(200, {
    users: users.length,
    disabledUsers: users.filter((u) => u.disabled).length,
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
  const registry = await listRegistry(app)
  const users = await Promise.all(registry.map((r) => summarize(app, r)))
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
  await leaveAllOrgs(app, id, false)
  for (const item of await app.store.query(userPk(id))) await app.store.delete(item.pk, item.sk)
  await app.store.delete(emailPk(reg.emailDigest), EMAIL_SK)
  await app.store.delete(SYSTEM_PK, registrySk(id))
  return json(200, { ok: true })
}

export async function getSettingsRoute(app: App): Promise<LambdaResponse> {
  return json(200, { ...(await getSettings(app)), registrationForcedOpen: app.allowRegistration })
}

export async function putSettingsRoute(app: App, actor: string, event: LambdaEvent): Promise<LambdaResponse> {
  const body = parseJsonBody<{ registration?: unknown }>(event)
  if (!REGISTRATION_MODES.includes(body.registration as RegistrationMode)) {
    throw badRequest(`registration must be one of: ${REGISTRATION_MODES.join(', ')}.`)
  }
  const registration = body.registration as RegistrationMode
  await audit(app, actor, 'settings.registration', undefined, registration)
  await putSettings(app, { registration, updatedAt: new Date(app.now()).toISOString() })
  return json(200, { ok: true })
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
  const emailed = email ? await notify(app.mailer, { to: email, ...inviteMessage(app.config.origin, code, label, invite.expiresAt) }) : false
  // The code is returned exactly once. Only its hash is stored.
  return json(201, { code, emailed, invite: { id: invite.id, label, expiresAt: invite.expiresAt, role } })
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
