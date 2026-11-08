// What the operator manages: whether registration is open, the registry of
// accounts, invitations, and the admin audit log. All of it lives in the
// SYSTEM partition (see keys.ts), and none of it is vault content — the
// operator can manage accounts without being able to read a single entry.
//
// See decisions/0006-admin-panel.md.

import { createHash, randomBytes, randomUUID } from 'node:crypto'

import type { App } from './context.js'
import { forbidden } from './http.js'
import {
  AUDIT_PREFIX,
  INVITE_PREFIX,
  REGISTRY_PREFIX,
  SETTINGS_SK,
  SYSTEM_PK,
  auditSk,
  inviteSk,
  inviteUsedSk,
  registrySk,
} from './keys.js'
import { AlreadyExists, type Item } from './store.js'

// ── Settings ──────────────────────────────────────────────────────────────

/** `closed`: nobody can register. `invite`: only with a valid invitation.
 *  `open`: anyone who finds the address. Closed is the default, so an empty or
 *  unreadable setting refuses rather than admits. */
export type RegistrationMode = 'closed' | 'invite' | 'open'
export const REGISTRATION_MODES: readonly RegistrationMode[] = ['closed', 'invite', 'open']

/** What this server calls itself and where its people get help. Shown on the
 *  sign-in screen and the help page, and used as the Reply-To of every email,
 *  so a reply reaches the operator's support mailbox. All of it is public. */
export interface InstanceProfile {
  name: string
  supportEmail: string
  supportUrl: string
}

/** Server-wide rules an administrator sets for every account (G1, G3, G7).
 *  Two-factor and password strength are shown to anyone who misses them and
 *  listed for admins; nobody is locked out by a policy change. The password
 *  score is self-reported by the account's own app, as for organizations. */
export interface ServerPolicy {
  requireTwoFactor: boolean
  /** 0 (none) to 4, packages/core passwordStrength. */
  minPasswordScore: number
  /** The longest auto-lock any account may choose; null: their choice. */
  maxIdleMinutes: number | null
  /** Sign in again this many days after signing in on a device, however
   *  often it is used; null: stay signed in while used (30 idle days). */
  sessionDays: number | null
  /** How long each account's activity log is kept. */
  activityDays: number
  /** How long the admin audit log and organization event logs are kept. */
  auditDays: number
  /** Whether people may share an item by link (G4), and for how long at most. */
  shareLinks: boolean
  shareLinkMaxDays: number
  /** Where accounts may sign in from (G2): addresses or CIDR ranges; empty for anywhere. Owners are exempt. */
  allowedNetworks: string[]
}

export const POLICY_CHOICES = {
  minPasswordScore: [0, 1, 2, 3, 4],
  maxIdleMinutes: [null, 1, 5, 15, 30, 60, 240],
  sessionDays: [null, 1, 7, 14, 30],
  activityDays: [30, 90, 180, 365],
  auditDays: [90, 365, 730, 1825],
  shareLinkMaxDays: [1, 7, 30],
} as const

export const DEFAULT_POLICY: Readonly<ServerPolicy> = Object.freeze({
  requireTwoFactor: false, minPasswordScore: 0, maxIdleMinutes: null, sessionDays: null, activityDays: 90, auditDays: 365, shareLinks: true, shareLinkMaxDays: 30, allowedNetworks: [],
})

/** A stored policy, with anything missing or out of range taken from the
 *  defaults, so a damaged row never weakens or breaks anything. */
export function readPolicy(value: unknown): ServerPolicy {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const pick = <K extends keyof typeof POLICY_CHOICES>(k: K): ServerPolicy[K] =>
    ((POLICY_CHOICES[k] as readonly unknown[]).includes(v[k]) ? v[k] : DEFAULT_POLICY[k]) as ServerPolicy[K]
  return {
    requireTwoFactor: v['requireTwoFactor'] === true,
    minPasswordScore: pick('minPasswordScore'),
    maxIdleMinutes: pick('maxIdleMinutes'),
    sessionDays: pick('sessionDays'),
    activityDays: pick('activityDays'),
    auditDays: pick('auditDays'),
    shareLinks: v['shareLinks'] !== false,
    shareLinkMaxDays: pick('shareLinkMaxDays'),
    allowedNetworks: Array.isArray(v['allowedNetworks']) ? (v['allowedNetworks'] as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 50) : [],
  }
}

export interface Settings {
  registration: RegistrationMode
  profile: InstanceProfile
  policy: ServerPolicy
  /** An admin's subject and message per email (G6); missing means the default. */
  templates: Partial<Record<'invite' | 'signIn', { subject: string; message: string }>>
  updatedAt?: string
}

function readProfile(value: unknown): InstanceProfile {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const str = (k: string) => (typeof v[k] === 'string' ? (v[k] as string) : '')
  return { name: str('name'), supportEmail: str('supportEmail'), supportUrl: str('supportUrl') }
}

function readTemplates(value: unknown): Settings['templates'] {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const out: Settings['templates'] = {}
  for (const k of ['invite', 'signIn'] as const) {
    const t = v[k] as Record<string, unknown> | undefined
    if (t && typeof t['subject'] === 'string' && typeof t['message'] === 'string') out[k] = { subject: t['subject'], message: t['message'] }
  }
  return out
}

export async function getSettings(app: App): Promise<Settings> {
  const item = await app.store.get(SYSTEM_PK, SETTINGS_SK)
  const mode = item?.['registration']
  return {
    registration: REGISTRATION_MODES.includes(mode as RegistrationMode) ? (mode as RegistrationMode) : 'closed',
    profile: readProfile(item?.['profile']),
    policy: readPolicy(item?.['policy']),
    templates: readTemplates(item?.['templates']),
    ...(typeof item?.['updatedAt'] === 'string' ? { updatedAt: item['updatedAt'] } : {}),
  }
}

export async function putSettings(app: App, settings: Settings): Promise<void> {
  await app.store.put({ pk: SYSTEM_PK, sk: SETTINGS_SK, ...settings })
}

// ── Registry ──────────────────────────────────────────────────────────────

/** One row per account, so the admin routes can list accounts with a single
 *  partition query rather than a table scan. It holds no address — the
 *  operator identifies an account by the label given to its invitation, or by
 *  one they set later. */
export interface RegistryFields {
  userId: string
  emailDigest: string
  createdAt: string
  lastLoginAt?: string
  label?: string
  disabled?: boolean
  inviteId?: string
  /** A staff role granted by an owner: admin, marketing or viewer. Absent
   *  means a plain user. Owner is never stored; see roles.ts. */
  role?: string
}
export type RegistryEntry = Item & RegistryFields

export async function getRegistry(app: App, userId: string): Promise<RegistryEntry | null> {
  return (await app.store.get(SYSTEM_PK, registrySk(userId))) as RegistryEntry | null
}

export async function listRegistry(app: App): Promise<RegistryEntry[]> {
  return (await app.store.query(SYSTEM_PK, REGISTRY_PREFIX)) as RegistryEntry[]
}

export async function putRegistry(app: App, entry: RegistryFields): Promise<void> {
  await app.store.put({ ...entry, pk: SYSTEM_PK, sk: registrySk(entry.userId) })
}

export async function touchLogin(
  app: App, userId: string, profile: { emailDigest: string; createdAt: string },
): Promise<void> {
  // Best effort, like activity: failing to record a login time must not fail
  // the login.
  try {
    const at = new Date(app.now()).toISOString()
    const entry = await getRegistry(app, userId)
    if (entry) {
      await app.store.put({ ...entry, lastLoginAt: at })
    } else {
      // An account created before the registry existed. Give it a row on its
      // first sign-in, so it appears in the admin panel like any other.
      await putRegistry(app, { userId, emailDigest: profile.emailDigest, createdAt: profile.createdAt, lastLoginAt: at })
    }
  } catch {
    /* recorded next time */
  }
}

/** Refuses a disabled account. Called at login, recovery and refresh: access
 *  tokens live fifteen minutes and disabling revokes every refresh token, so
 *  checking on every request would buy at most fifteen minutes for a read on
 *  every call. */
export async function assertEnabled(app: App, userId: string): Promise<void> {
  const entry = await getRegistry(app, userId)
  if (entry?.disabled) throw forbidden()
}

// ── Invitations ───────────────────────────────────────────────────────────

/** Crockford's base32: no I, L, O or U, so a code read aloud or typed from a
 *  phone has nothing to misread. */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** 120 bits, as six groups of four. Each byte carries five usable bits, so
 *  the modulo below is exact and introduces no bias. */
export function newInviteCode(): string {
  const chars = [...randomBytes(24)].map((b) => CODE_ALPHABET[b & 31]).join('')
  return chars.match(/.{4}/g)!.join('-')
}

/** Only the hash is stored, so the table cannot be used to register. */
export function hashInviteCode(code: string): string {
  return createHash('sha256').update(`invite|${code.trim().toUpperCase()}`).digest('base64url')
}

export interface Invite extends Item {
  id: string
  label: string
  createdAt: string
  expiresAt: string
  createdBy: string
  usedAt?: string
  usedBy?: string
  /** The role the new account starts with. Absent means a plain user. */
  role?: string
  /** First-run setup: creates the owner, even while registration is closed. */
  setup?: boolean
}

export async function createInvite(
  app: App, actor: string, label: string, days: number, role?: string,
): Promise<{ code: string; invite: Invite }> {
  const code = newInviteCode()
  const id = hashInviteCode(code)
  const now = app.now()
  const invite: Invite = {
    pk: SYSTEM_PK,
    sk: inviteSk(id),
    id,
    label,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + days * 86_400_000).toISOString(),
    createdBy: actor,
    ...(role && role !== 'user' ? { role } : {}),
  }
  await app.store.put(invite, { mustNotExist: true })
  return { code, invite }
}

export async function listInvites(app: App): Promise<Invite[]> {
  return (await app.store.query(SYSTEM_PK, INVITE_PREFIX)) as Invite[]
}

export async function deleteInvite(app: App, id: string): Promise<void> {
  await app.store.delete(SYSTEM_PK, inviteSk(id))
}

/** Checks an invitation and claims it, exactly once. The claim is a
 *  conditional insert of a marker row, so two registrations racing on one code
 *  cannot both succeed. Returns the invitation, or null if it cannot be used. */
export async function claimInvite(app: App, code: string, userId: string): Promise<Invite | null> {
  const id = hashInviteCode(code)
  const invite = (await app.store.get(SYSTEM_PK, inviteSk(id))) as Invite | null
  if (!invite || invite.usedAt) return null
  if (Date.parse(invite.expiresAt) <= app.now()) return null
  try {
    await app.store.put({ pk: SYSTEM_PK, sk: inviteUsedSk(id), userId }, { mustNotExist: true })
  } catch (err) {
    if (err instanceof AlreadyExists) return null
    throw err
  }
  const at = new Date(app.now()).toISOString()
  await app.store.put({ ...invite, usedAt: at, usedBy: userId })
  return invite
}

// ── First-run setup ─────────────────────────────────────────────────────

const SETUP_DAYS = 7

/** On a server with no accounts and no ADMIN_EMAILS, issues a one-time code
 *  that creates the owner account, and returns it for the log. Only its hash
 *  is stored, so a new code is issued on every start until one is used — the
 *  person who can read the server's log is the person who runs it. Returns
 *  null once any account exists, and withdraws unused setup codes then. */
export async function ensureSetup(app: App): Promise<string | null> {
  const stale = (await listInvites(app)).filter((i) => i.setup && !i.usedAt)
  for (const i of stale) await deleteInvite(app, i.id)
  if (app.adminDigests.size > 0) return null
  if ((await listRegistry(app)).length > 0) return null
  const { code } = await createInvite(app, 'system', 'First-run setup', SETUP_DAYS, 'owner')
  const setup = (await app.store.get(SYSTEM_PK, inviteSk(hashInviteCode(code)))) as Invite
  await app.store.put({ ...setup, setup: true })
  return code
}

// ── Audit ─────────────────────────────────────────────────────────────────


export interface AuditRecord extends Item {
  at: string
  actor: string
  action: string
  target?: string
  detail?: string
}

/** Every admin action is recorded. Unlike user activity this is not best
 *  effort: an admin action that cannot be audited does not happen, so the
 *  record is written before the action and a failure stops it. */
export async function audit(
  app: App, actor: string, action: string, target?: string, detail?: string,
): Promise<void> {
  const at = new Date(app.now()).toISOString()
  await app.store.put({
    pk: SYSTEM_PK,
    sk: auditSk(at, randomUUID().slice(0, 8)),
    at,
    actor,
    action,
    ...(target ? { target } : {}),
    ...(detail ? { detail } : {}),
    expiresAt: Math.floor(app.now() / 1000) + (await getSettings(app)).policy.auditDays * 86_400,
  })
}

/** What stops this account meeting the server policy, if anything. */
export function serverPolicyGap(policy: ServerPolicy, profile: Item | null): string | null {
  if (policy.requireTwoFactor && !profile?.['totp']) return 'This server requires two-factor sign-in. Turn it on in Settings → Security.'
  if (policy.minPasswordScore && Number(profile?.['passwordScore'] ?? 0) < policy.minPasswordScore) {
    return 'This server requires a stronger master password. Change it in Settings → Security.'
  }
  return null
}

export async function listAudit(app: App, limit = 200): Promise<AuditRecord[]> {
  const rows = (await app.store.query(SYSTEM_PK, AUDIT_PREFIX)) as AuditRecord[]
  return rows.reverse().slice(0, limit)
}
