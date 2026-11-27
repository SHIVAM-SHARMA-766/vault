// The security dashboard and reports (admin console phase 2).
//
//   GET /api/admin/insights          what needs attention, with counts and
//                                    where to look; sign-ins per day
//   GET /api/admin/reports/:kind     one report as JSON or CSV
//   weekly digest                    the same summary, emailed to owners and
//                                    admins once a week (policy.weeklyDigest)
//
// Everything here is about accounts and staff actions. Nothing reads vault
// contents: the server cannot, and the reports say so by what they hold.

import { mapLimit } from '../limit.js'
import type { App } from '../context.js'
import { HttpError, type LambdaEvent, type LambdaResponse, json, notFound } from '../http.js'
import { SYSTEM_PK, userPk, PROFILE_SK } from '../keys.js'
import { notify } from '../mail.js'
import { type Role, roleFromDigest } from '../roles.js'
import { dailyStats } from '../stats.js'
import { type RegistryEntry, type ServerPolicy, getSettings, listAudit, listRegistry, serverPolicyGap } from '../system.js'
import { hasSecondFactor } from '../twofactor.js'
import { INACTIVE_DAYS, emailOf } from './admin.js'
import { openTicketCount } from './desk.js'

const STAFF: readonly Role[] = ['owner', 'admin', 'support', 'marketing', 'viewer']

/** Every account with what the dashboard and the reports need: the registry
 *  row and the profile, one read each. */
interface Row {
  userId: string
  email: string | null
  label: string | null
  role: Role
  disabled: boolean
  createdAt: string
  lastLoginAt: string | null
  twoFactor: boolean
  policyGap: string | null
}

async function rows(app: App, registry: RegistryEntry[], policy: ServerPolicy): Promise<Row[]> {
  return mapLimit(registry, async (r) => {
    const profile = await app.store.get(userPk(r.userId), PROFILE_SK)
    return {
      userId: r.userId, email: emailOf(app, r), label: r.label ?? null, role: roleFromDigest(app, r.emailDigest, r.role),
      disabled: r.disabled === true, createdAt: r.createdAt, lastLoginAt: r.lastLoginAt ?? null,
      twoFactor: hasSecondFactor(profile), policyGap: serverPolicyGap(policy, profile ?? null),
    }
  })
}

export interface Attention {
  id: string
  level: 'high' | 'medium' | 'low'
  count: number
  title: string
  detail: string
  /** Where the console shows the accounts behind it. */
  go: { tab: string; status?: string; twoFactor?: string; role?: string }
}

/** What an operator should look at, most urgent first; empty when all is well. */
async function attention(app: App, list: Row[]): Promise<Attention[]> {
  const out: Attention[] = []
  const active = list.filter((r) => !r.disabled)
  const since = app.now() - INACTIVE_DAYS * 86_400_000
  const staffNo2fa = active.filter((r) => STAFF.includes(r.role) && !r.twoFactor)
  if (staffNo2fa.length) out.push({ id: 'staff-2fa', level: 'high', count: staffNo2fa.length, title: 'Staff without two-factor sign-in', detail: 'Accounts that can change this server sign in with a password alone.', go: { tab: 'users', twoFactor: 'off' } })
  const days = await dailyStats(app, 8)
  const today = days.at(-1)!['signin-failed']
  const before = days.slice(0, -1).reduce((n, d) => n + d['signin-failed'], 0) / 7
  if (today >= 10 && today > 3 * Math.max(before, 1)) out.push({ id: 'failed-spike', level: 'high', count: today, title: 'More failed sign-ins than usual today', detail: `${today} today against about ${Math.round(before)} a day this past week. Look at the audit log and the sign-in chart.`, go: { tab: 'overview' } })
  const gap = active.filter((r) => r.policyGap)
  if (gap.length) out.push({ id: 'policy', level: 'medium', count: gap.length, title: 'Accounts that miss the server policy', detail: 'Two-factor sign-in or master password strength below what the policy asks.', go: { tab: 'users', status: 'active' } })
  const no2fa = active.filter((r) => !r.twoFactor)
  if (no2fa.length) out.push({ id: 'no-2fa', level: 'medium', count: no2fa.length, title: 'Accounts without two-factor sign-in', detail: 'A stolen password alone opens these accounts. Policies → require two-factor sign-in.', go: { tab: 'users', twoFactor: 'off' } })
  const inactive = active.filter((r) => r.lastLoginAt && Date.parse(r.lastLoginAt) < since)
  if (inactive.length) out.push({ id: 'inactive', level: 'low', count: inactive.length, title: `Not signed in for ${INACTIVE_DAYS} days`, detail: 'People who may have left. Offboard them, or ask.', go: { tab: 'users', status: 'inactive' } })
  const never = active.filter((r) => !r.lastLoginAt)
  if (never.length) out.push({ id: 'never', level: 'low', count: never.length, title: 'Never signed in', detail: 'Accounts made but not used since.', go: { tab: 'users', status: 'never' } })
  const requests = (await app.store.query(SYSTEM_PK, 'VREQ#')).length
  if (requests) out.push({ id: 'vault-requests', level: 'medium', count: requests, title: 'Vault requests waiting', detail: 'People with an account asking for a vault.', go: { tab: 'invites' } })
  const tickets = await openTicketCount(app)
  if (tickets) out.push({ id: 'tickets', level: 'low', count: tickets, title: 'Open service desk tickets', detail: 'Requests for access or help not answered yet.', go: { tab: 'desk' } })
  return out
}

export async function insights(app: App): Promise<LambdaResponse> {
  const [registry, { policy }] = await Promise.all([listRegistry(app), getSettings(app)])
  const list = await rows(app, registry, policy)
  const active = list.filter((r) => !r.disabled)
  const roles: Record<string, number> = {}
  for (const r of list) roles[r.role] = (roles[r.role] ?? 0) + 1
  return json(200, {
    attention: await attention(app, list),
    daily: await dailyStats(app, 30),
    twoFactor: { on: active.filter((r) => r.twoFactor).length, off: active.filter((r) => !r.twoFactor).length },
    roles,
  })
}

// ── Reports ─────────────────────────────────────────────────────────────────

export const REPORTS = {
  'two-factor': 'Two-factor sign-in, per account',
  inactive: `Accounts not signed in for ${INACTIVE_DAYS} days, or never`,
  staff: 'Staff accounts: roles, two-factor, last sign-in',
  policy: 'Accounts that miss the server policy, and why',
  signins: 'Sign-ins, failed sign-ins and new accounts per day (90 days)',
  'admin-actions': 'Staff actions in the last 30 days, per person and action',
  organizations: 'Organizations: members and roles',
} as const
export type ReportKind = keyof typeof REPORTS

type Table = { columns: string[]; rows: (string | number | boolean | null)[][] }

async function build(app: App, kind: ReportKind): Promise<Table> {
  const [registry, { policy }] = await Promise.all([listRegistry(app), getSettings(app)])
  const account = (r: Row) => r.email ?? r.label ?? r.userId
  if (kind === 'signins') {
    const days = await dailyStats(app, 90)
    return { columns: ['day', 'sign_ins', 'failed_sign_ins', 'new_accounts'], rows: days.map((d) => [d.day, d.signin, d['signin-failed'], d.signup]) }
  }
  if (kind === 'admin-actions') {
    const since = new Date(app.now() - 30 * 86_400_000).toISOString()
    const labels = new Map(registry.map((r) => [r.userId, emailOf(app, r) ?? r.label ?? r.userId]))
    const counts = new Map<string, number>()
    for (const a of await listAudit(app, 100_000)) {
      if (a.at < since) continue
      const key = `${labels.get(a.actor) ?? a.actor}\u0000${a.action}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return { columns: ['staff', 'action', 'count'], rows: [...counts].map(([k, n]) => [...k.split('\u0000'), n] as [string, string, number]).sort((a, b) => b[2] - a[2]) }
  }
  if (kind === 'organizations') {
    const orgs = new Map<string, { name: string; kind: string; roles: Record<string, number> }>()
    for (const r of registry) {
      for (const ref of await app.store.query(userPk(r.userId), 'ORG#')) {
        const orgId = String(ref['orgId'] ?? '')
        if (!orgId) continue
        if (!orgs.has(orgId)) {
          const meta = await app.store.get(`ORG#${orgId}`, 'META')
          if (!meta) continue
          orgs.set(orgId, { name: String(meta['hint'] ?? ''), kind: String(meta['kind'] ?? 'team'), roles: {} })
        }
        const m = await app.store.get(`ORG#${orgId}`, `MEMBER#${r.userId}`)
        if (!m) continue
        const o = orgs.get(orgId)!
        const role = String(m['role'] ?? 'member')
        o.roles[role] = (o.roles[role] ?? 0) + 1
      }
    }
    return {
      columns: ['organization', 'kind', 'members', 'owners', 'admins', 'members_other'],
      rows: [...orgs.values()].filter((o) => o.kind !== 'direct').map((o) => {
        const total = Object.values(o.roles).reduce((a, b) => a + b, 0)
        return [o.name || 'Unnamed', o.kind, total, o.roles['owner'] ?? 0, o.roles['admin'] ?? 0, total - (o.roles['owner'] ?? 0) - (o.roles['admin'] ?? 0)]
      }).sort((a, b) => Number(b[2]) - Number(a[2])),
    }
  }
  const list = await rows(app, registry, policy)
  if (kind === 'two-factor') return { columns: ['account', 'role', 'status', 'two_factor', 'last_sign_in'], rows: list.map((r) => [account(r), r.role, r.disabled ? 'disabled' : 'active', r.twoFactor, r.lastLoginAt]) }
  if (kind === 'inactive') {
    const since = app.now() - INACTIVE_DAYS * 86_400_000
    return { columns: ['account', 'role', 'created', 'last_sign_in'], rows: list.filter((r) => !r.disabled && (!r.lastLoginAt || Date.parse(r.lastLoginAt) < since)).map((r) => [account(r), r.role, r.createdAt, r.lastLoginAt]) }
  }
  if (kind === 'staff') return { columns: ['account', 'role', 'status', 'two_factor', 'last_sign_in'], rows: list.filter((r) => STAFF.includes(r.role)).map((r) => [account(r), r.role, r.disabled ? 'disabled' : 'active', r.twoFactor, r.lastLoginAt]) }
  return { columns: ['account', 'role', 'reason'], rows: list.filter((r) => !r.disabled && r.policyGap).map((r) => [account(r), r.role, r.policyGap]) }
}

/** CSV with a guard against spreadsheet formulas in any cell. */
export function toCsv(t: Table): string {
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? '' : String(v)
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
    return /[",\n\r]/.test(s) || s.startsWith("'") ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [t.columns.join(','), ...t.rows.map((r) => r.map(cell).join(','))].join('\n')
}

export async function report(app: App, kind: string, event: LambdaEvent): Promise<LambdaResponse> {
  if (!(kind in REPORTS)) throw notFound()
  const table = await build(app, kind as ReportKind)
  const format = new URLSearchParams(event.rawQueryString ?? '').get('format')
  if (format === 'csv') {
    return { statusCode: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="vault-${kind}-${new Date(app.now()).toISOString().slice(0, 10)}.csv"`, 'cache-control': 'no-store' }, body: toCsv(table) }
  }
  return json(200, { kind, title: REPORTS[kind as ReportKind], ...table })
}

export async function reportList(): Promise<LambdaResponse> {
  return json(200, { reports: Object.entries(REPORTS).map(([kind, title]) => ({ kind, title })) })
}

// ── Weekly digest ───────────────────────────────────────────────────────────

const DIGEST_SK = 'DIGEST'
const WEEK_MS = 7 * 86_400_000

/** Once a week (checked hourly by the server), when the policy allows and
 *  mail is set up: the summary, to every owner and admin with an address.
 *  Returns how many were sent. */
export async function tickDigest(app: App, force = false): Promise<number> {
  if (!app.mailer) return 0
  const { policy, profile } = await getSettings(app)
  if (!policy.weeklyDigest && !force) return 0
  const last = await app.store.get(SYSTEM_PK, DIGEST_SK)
  if (!force && last && app.now() - Date.parse(String(last['at'])) < WEEK_MS) return 0
  // Claimed first, so two servers (or a restart) do not both send it.
  await app.store.put({ pk: SYSTEM_PK, sk: DIGEST_SK, at: new Date(app.now()).toISOString() })
  const registry = await listRegistry(app)
  const list = await rows(app, registry, policy)
  const items = await attention(app, list)
  const days = await dailyStats(app, 7)
  const sum = (k: 'signin' | 'signin-failed' | 'signup') => days.reduce((n, d) => n + d[k], 0)
  const name = profile.name || 'Vault'
  const text = [
    `This week on ${name} (${app.config.origin}):`,
    '',
    `- ${sum('signin')} sign-ins, ${sum('signin-failed')} failed sign-ins, ${sum('signup')} new vaults`,
    `- ${list.filter((r) => !r.disabled).length} active accounts, ${list.filter((r) => r.disabled).length} disabled`,
    '',
    items.length ? 'Needs attention:' : 'Nothing needs attention.',
    ...items.map((a) => `- ${a.title}: ${a.count}. ${a.detail}`),
    '',
    `Open the admin console: ${app.config.origin}/app/console`,
    '',
    'Sent once a week to owners and admins. Turn it off in Admin console → Overview → Server policies.',
  ].join('\n')
  let sent = 0
  for (const r of list) {
    if (r.disabled || !r.email || (r.role !== 'owner' && r.role !== 'admin')) continue
    if (await notify(app, { to: r.email, subject: `${name}: your weekly summary`, text })) sent++
  }
  return sent
}

export async function sendDigestNow(app: App): Promise<LambdaResponse> {
  if (!app.mailer) throw new HttpError(503, 'unavailable', 'Mail is not set up on this server (SMTP_HOST).')
  return json(200, { sent: await tickDigest(app, true) })
}
