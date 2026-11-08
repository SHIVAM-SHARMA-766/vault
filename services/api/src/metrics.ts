// Prometheus metrics (B6) at /api/metrics, for a scraper holding METRICS_TOKEN.
// Counts only: how many accounts, items, sessions, and how requests went. No
// address, label, id or vault content ever appears here.

import { timingSafeEqual } from 'node:crypto'

import type { App } from './context.js'
import { HttpError, type LambdaEvent, type LambdaResponse } from './http.js'
import { BACKUP_SK, ENTRY_PREFIX, SESSION_PREFIX, SYSTEM_ORG_PREFIX, SYSTEM_PK, userPk } from './keys.js'
import { getSettings, listInvites, listRegistry } from './system.js'

const started = Date.now()
const requests = new Map<string, number>()   // `${method} ${class}` → count
let durationSum = 0
let durationCount = 0

/** Called for every request (app.ts). Cheap: a map increment. */
export function recordRequest(method: string, status: number, ms: number): void {
  const key = `${method} ${Math.floor(status / 100)}xx`
  requests.set(key, (requests.get(key) ?? 0) + 1)
  durationSum += ms / 1000
  durationCount++
}

function authorised(app: App, event: LambdaEvent): boolean {
  const want = Buffer.from(app.config.metricsToken)
  const header = event.headers['authorization'] ?? event.headers['Authorization'] ?? ''
  const got = Buffer.from(header.replace(/^Bearer\s+/i, ''))
  return want.length > 0 && got.length === want.length && timingSafeEqual(got, want)
}

export async function metricsRoute(app: App, event: LambdaEvent): Promise<LambdaResponse> {
  // Off unless configured, and indistinguishable from a missing page.
  if (!app.config.metricsToken) throw new HttpError(404, 'not_found', 'Not found.')
  if (!authorised(app, event)) throw new HttpError(401, 'unauthorized', 'A metrics token is required.')

  const [registry, invites, settings, backup, orgs] = await Promise.all([
    listRegistry(app), listInvites(app), getSettings(app), app.store.get(SYSTEM_PK, BACKUP_SK), app.store.query(SYSTEM_PK, SYSTEM_ORG_PREFIX),
  ])
  const nowS = Math.floor(app.now() / 1000)
  let entries = 0
  let sessions = 0
  for (const r of registry) {
    for (const row of await app.store.query(userPk(r.userId))) {
      if (row.sk.startsWith(ENTRY_PREFIX)) entries++
      else if (row.sk.startsWith(SESSION_PREFIX) && (typeof row['expiresAt'] !== 'number' || row['expiresAt'] > nowS)) sessions++
    }
  }
  const lines: string[] = []
  const metric = (name: string, help: string, type: 'gauge' | 'counter', samples: [string, number][]) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`)
    for (const [labels, v] of samples) lines.push(`${name}${labels} ${v}`)
  }
  metric('vault_info', 'The running version.', 'gauge', [[`{version="${app.config.version.replace(/[^\w.+-]/g, '')}"}`, 1]])
  metric('vault_uptime_seconds', 'Seconds since the server started.', 'gauge', [['', Math.floor((Date.now() - started) / 1000)]])
  metric('vault_accounts', 'Accounts, by state.', 'gauge', [['{state="active"}', registry.filter((r) => !r.disabled).length], ['{state="disabled"}', registry.filter((r) => r.disabled).length]])
  metric('vault_items', 'Encrypted items in personal vaults.', 'gauge', [['', entries]])
  metric('vault_sessions', 'Signed-in devices.', 'gauge', [['', sessions]])
  metric('vault_organizations', 'Organizations, including direct shares.', 'gauge', [['', orgs.length]])
  metric('vault_invitations_active', 'Unused, unexpired invitations.', 'gauge', [['', invites.filter((i) => !i.usedAt && Date.parse(i.expiresAt) > app.now()).length]])
  metric('vault_registration_open', '1 when anyone can create an account.', 'gauge', [['', settings.registration === 'open' || app.allowRegistration ? 1 : 0]])
  metric('vault_backup_last_success_timestamp_seconds', 'When the last server backup was written (0: never).', 'gauge', [['', backup?.['at'] ? Math.floor(Date.parse(String(backup['at'])) / 1000) : 0]])
  metric('vault_mail_configured', '1 when SMTP is set up.', 'gauge', [['', app.mailer ? 1 : 0]])
  metric('vault_http_requests_total', 'Requests handled, by method and status class.', 'counter',
    [...requests.entries()].sort().map(([k, v]) => { const [m, c] = k.split(' '); return [`{method="${m}",status="${c}"}`, v] }))
  metric('vault_http_request_duration_seconds_sum', 'Total time spent handling requests.', 'counter', [['', Number(durationSum.toFixed(3))]])
  metric('vault_http_request_duration_seconds_count', 'Requests timed.', 'counter', [['', durationCount]])
  return { statusCode: 200, headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' }, body: lines.join('\n') + '\n' }
}
