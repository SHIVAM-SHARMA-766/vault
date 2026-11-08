// Personal backups: each person's own schedule and destination
// (decisions/0017). The server builds the file from ciphertext it already
// holds and needs no key to do it; the file opens only with the master
// password, or the recovery key, that was current when it was made.
//
// Rows:
//   USER#<id>   BKCFG                 schedule, destination, next run
//   USER#<id>   BKRUN#<at>#<n>        one run: when, where, size, result
//   USER#<id>   BKCOPY#<at>#<n>       a copy kept on this server
//   SYSTEM      BKDUE#<id>            when the schedule next falls due (the timer's index)

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

import type { App } from './context.js'
import { EgressRefused, checkDestinationUrl, guardedRequest } from './egress.js'
import { ENTRY_PREFIX, FOLDER_PREFIX, PREFS_SK, PROFILE_SK, SYSTEM_PK, userPk } from './keys.js'
import { type S3Target, type Transport, s3Object } from './s3.js'

export const BKCFG_SK = 'BKCFG'
export const BKRUN_PREFIX = 'BKRUN#'
export const BKCOPY_PREFIX = 'BKCOPY#'
export const BKDUE_PREFIX = 'BKDUE#'
export const bkdueSk = (userId: string) => `${BKDUE_PREFIX}${userId}`

/** A copy kept on this server lives in the database beside the vault. */
export const SERVER_COPY_MAX_BYTES = 20 * 1024 * 1024
/** Copies kept on the server are capped lower than remote ones: each is a
 *  full copy of the vault in the same database, and in every server backup. */
export const SERVER_KEEP_MAX = 10
/** Runs remembered per person, for the history in Settings. */
const RUNS_KEPT = 20

export type Frequency = 'off' | 'daily' | 'weekly' | 'monthly'
export const FREQUENCIES: readonly Frequency[] = ['off', 'daily', 'weekly', 'monthly']

export interface Schedule {
  frequency: Frequency
  /** Local hour, 0–23. */
  hour: number
  /** 0 = Sunday; used by weekly. */
  weekday: number
  /** Minutes east of UTC, as the browser reported it (India: 330). */
  tzOffsetMinutes: number
  /** Copies kept at the destination, 1–30. */
  keep: number
}

export type Destination =
  | { type: 'server' }
  | { type: 's3'; endpoint: string; region: string; bucket: string; prefix: string; accessKey: string; secretKey: string }
  | { type: 'webdav'; url: string; username: string; password: string }

/** As stored: secrets sealed under a server key. */
type StoredDestination =
  | { type: 'server' }
  | { type: 's3'; endpoint: string; region: string; bucket: string; prefix: string; accessKey: string; secretKeySealed: string }
  | { type: 'webdav'; url: string; username: string; passwordSealed: string }

export const DEFAULT_SCHEDULE: Schedule = { frequency: 'off', hour: 2, weekday: 0, tzOffsetMinutes: 0, keep: 7 }

// ── Schedule ──────────────────────────────────────────────────────────────

/** The first moment strictly after `from` that the schedule falls due, or
 *  null when it is off. Weekly runs on the chosen weekday; monthly on the 1st.
 *  Computed in the person's local time, so 02:00 means 02:00 where they are. */
export function nextRun(s: Schedule, from: number): number | null {
  if (s.frequency === 'off') return null
  const shift = s.tzOffsetMinutes * 60_000
  const local = new Date(from + shift)
  const at = (y: number, m: number, d: number) => Date.UTC(y, m, d, s.hour, 0, 0) - shift
  const y = local.getUTCFullYear(), m = local.getUTCMonth(), d = local.getUTCDate()
  if (s.frequency === 'daily') {
    const today = at(y, m, d)
    return today > from ? today : at(y, m, d + 1)
  }
  if (s.frequency === 'weekly') {
    const ahead = (s.weekday - local.getUTCDay() + 7) % 7
    const candidate = at(y, m, d + ahead)
    return candidate > from ? candidate : at(y, m, d + ahead + 7)
  }
  const thisMonth = at(y, m, 1)
  return thisMonth > from ? thisMonth : at(y, m + 1, 1)
}

// ── Sealing destination secrets ───────────────────────────────────────────

const secretKey = (pepper: string) =>
  Buffer.from(hkdfSync('sha256', Buffer.from(pepper, 'utf8'), Buffer.from('vault'), Buffer.from('vault.backup-destination.v1'), 32))

/** Seals a destination secret at rest, bound to the account it belongs to. */
export function sealSecret(pepper: string, userId: string, plain: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', secretKey(pepper), iv)
  c.setAAD(Buffer.from(`bkdest:${userId}`))
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final(), c.getAuthTag()])
  return `srv1.${iv.toString('base64url')}.${body.toString('base64url')}`
}

export function openSecret(pepper: string, userId: string, sealed: string): string {
  const [v, iv, body] = sealed.split('.')
  if (v !== 'srv1' || !iv || !body) throw new Error('unreadable secret')
  const raw = Buffer.from(body, 'base64url')
  const d = createDecipheriv('aes-256-gcm', secretKey(pepper), Buffer.from(iv, 'base64url'))
  d.setAAD(Buffer.from(`bkdest:${userId}`))
  d.setAuthTag(raw.subarray(raw.length - 16))
  return Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString('utf8')
}

// ── Configuration ─────────────────────────────────────────────────────────

export interface BackupConfig {
  schedule: Schedule
  destination: StoredDestination
  nextRunAt: number | null
  updatedAt: string
}

export async function getConfig(app: App, userId: string): Promise<BackupConfig> {
  const item = await app.store.get(userPk(userId), BKCFG_SK)
  if (!item) return { schedule: DEFAULT_SCHEDULE, destination: { type: 'server' }, nextRunAt: null, updatedAt: '' }
  return {
    schedule: item['schedule'] as Schedule,
    destination: item['destination'] as StoredDestination,
    nextRunAt: typeof item['nextRunAt'] === 'number' ? item['nextRunAt'] : null,
    updatedAt: String(item['updatedAt'] ?? ''),
  }
}

/** What the client may see of a destination: everything but the secret. */
export function publicDestination(d: StoredDestination) {
  if (d.type === 's3') { const { secretKeySealed: _s, ...rest } = d; return { ...rest, hasSecret: true } }
  if (d.type === 'webdav') { const { passwordSealed: _p, ...rest } = d; return { ...rest, hasSecret: true } }
  return d
}

/** Saves a schedule and destination. A destination of the same type sent
 *  without its secret keeps the stored one, so the form need not echo it. */
export async function saveConfig(app: App, userId: string, schedule: Schedule, dest: Destination | (Omit<Destination & { type: 's3' }, 'secretKey'> & { secretKey?: string }) | (Omit<Destination & { type: 'webdav' }, 'password'> & { password?: string })): Promise<BackupConfig> {
  const before = await getConfig(app, userId)
  let stored: StoredDestination
  if (dest.type === 's3') {
    const keep = before.destination.type === 's3' ? before.destination.secretKeySealed : ''
    const sealed = dest.secretKey ? sealSecret(app.config.pepper, userId, dest.secretKey) : keep
    if (!sealed) throw new EgressRefused('Enter the secret access key.')
    stored = { type: 's3', endpoint: dest.endpoint, region: dest.region, bucket: dest.bucket, prefix: dest.prefix, accessKey: dest.accessKey, secretKeySealed: sealed }
  } else if (dest.type === 'webdav') {
    const keep = before.destination.type === 'webdav' ? before.destination.passwordSealed : ''
    const sealed = dest.password ? sealSecret(app.config.pepper, userId, dest.password) : keep
    if (!sealed) throw new EgressRefused('Enter the password.')
    stored = { type: 'webdav', url: dest.url, username: dest.username, passwordSealed: sealed }
  } else {
    stored = { type: 'server' }
  }
  const next = nextRun(schedule, app.now())
  const updatedAt = new Date(app.now()).toISOString()
  await app.store.put({ pk: userPk(userId), sk: BKCFG_SK, schedule, destination: stored, nextRunAt: next, updatedAt })
  if (next === null) await app.store.delete(SYSTEM_PK, bkdueSk(userId))
  else await app.store.put({ pk: SYSTEM_PK, sk: bkdueSk(userId), userId, nextRunAt: next })
  return { schedule, destination: stored, nextRunAt: next, updatedAt }
}

// ── The file ──────────────────────────────────────────────────────────────

export interface PersonalBackupFile {
  format: 'vault-personal-backup'
  version: 1
  createdAt: string
  kdf: unknown
  wrappedVaultKey: string
  recovery: { wrappedVaultKey: string } | null
  entries: { id: string; blob: string }[]
  folders: { id: string; blob: string }[]
  prefs: string | null
}

/** Everything needed to open the vault again, and nothing that helps anyone
 *  without the password: no auth verifier, no sessions, no address. */
export async function buildFile(app: App, userId: string): Promise<{ name: string; body: Buffer; entries: number }> {
  const rows = await app.store.query(userPk(userId))
  const profile = rows.find((r) => r.sk === PROFILE_SK)
  if (!profile) throw new Error('no such account')
  const at = new Date(app.now())
  const file: PersonalBackupFile = {
    format: 'vault-personal-backup', version: 1, createdAt: at.toISOString(),
    kdf: profile['kdf'], wrappedVaultKey: String(profile['wrappedVaultKey']),
    recovery: profile['wrappedVaultKeyForRecovery'] ? { wrappedVaultKey: String(profile['wrappedVaultKeyForRecovery']) } : null,
    entries: rows.filter((r) => r.sk.startsWith(ENTRY_PREFIX)).map((r) => ({ id: String(r['id']), blob: String(r['blob']) })),
    folders: rows.filter((r) => r.sk.startsWith(FOLDER_PREFIX)).map((r) => ({ id: String(r['id']), blob: String(r['blob']) })),
    prefs: (rows.find((r) => r.sk === PREFS_SK)?.['blob'] as string | undefined) ?? null,
  }
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
  return { name: `vault-backup-${stamp}.json`, body: Buffer.from(JSON.stringify(file)), entries: file.entries.length }
}

// ── Delivery ──────────────────────────────────────────────────────────────

const transportFor = (app: App): Transport => async (url, init) => {
  const res = await guardedRequest(url, { allowPrivate: app.config.personalBackup.allowPrivate, method: init.method, headers: init.headers, ...(init.body ? { body: init.body } : {}) })
  return { status: res.status, body: res.body }
}

function s3TargetOf(app: App, userId: string, d: StoredDestination & { type: 's3' }): S3Target {
  return { endpoint: d.endpoint, region: d.region, bucket: d.bucket, accessKey: d.accessKey, secretKey: openSecret(app.config.pepper, userId, d.secretKeySealed) }
}

const webdavUrl = (d: { url: string }, name: string) => `${d.url.replace(/\/+$/, '')}/${encodeURIComponent(name)}`

async function webdav(app: App, userId: string, d: StoredDestination & { type: 'webdav' }, method: 'PUT' | 'GET' | 'DELETE', name: string, body?: Buffer): Promise<Buffer> {
  const auth = Buffer.from(`${d.username}:${openSecret(app.config.pepper, userId, d.passwordSealed)}`).toString('base64')
  const res = await transportFor(app)(webdavUrl(d, name), {
    method, headers: { authorization: `Basic ${auth}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body } : {}),
  })
  if (res.status < 200 || res.status >= 300) {
    throw new Error(res.status === 401 || res.status === 403 ? `WebDAV refused the user name or password (${res.status}).`
      : res.status === 404 || res.status === 409 ? `WebDAV folder not found (${res.status}). Create it first.`
      : `WebDAV ${method} failed: ${res.status}`)
  }
  return res.body
}

/** Where a destination is, without its secret: to know which runs went where. */
export function destinationLabel(d: StoredDestination): string {
  if (d.type === 's3') return `s3:${d.endpoint.replace(/^https?:\/\//, '')}/${d.bucket}/${d.prefix}`
  if (d.type === 'webdav') return `webdav:${d.url.replace(/^https?:\/\//, '')}`
  return 'server'
}

export interface Run {
  id: string
  at: string
  ok: boolean
  destination: string
  name: string
  bytes: number
  entries: number
  reason: 'scheduled' | 'manual'
  error?: string
}

/** Sorts by time as text, and is safe in a URL. */
const runId = (at: string) => `${String(Date.parse(at)).padStart(15, '0')}-${randomBytes(3).toString('hex')}`

/** Errors as shown to the person: no stack, no secret, never too long. */
function describe(err: unknown): string {
  const code = (err as { code?: string }).code
  const msg = err instanceof Error ? err.message : String(err)
  const friendly = code === 'ENOTFOUND' ? 'The destination\'s host name does not exist.'
    : code === 'ECONNREFUSED' ? 'The destination refused the connection.'
    : code === 'ETIMEDOUT' ? 'The destination did not answer in time.'
    : code === 'CERT_HAS_EXPIRED' || /certificate/i.test(msg) ? 'The destination\'s TLS certificate is not valid.'
    : msg
  return friendly.slice(0, 200)
}

/** Builds a backup and delivers it. Never throws: the result is recorded. */
export async function runBackup(app: App, userId: string, reason: Run['reason']): Promise<Run | null> {
  if (!(await app.store.get(userPk(userId), PROFILE_SK))) {
    // The account is gone; so is its schedule.
    await app.store.delete(SYSTEM_PK, bkdueSk(userId))
    return null
  }
  const cfg = await getConfig(app, userId)
  const at = new Date(app.now()).toISOString()
  const run: Run = { id: runId(at), at, ok: false, destination: destinationLabel(cfg.destination), name: '', bytes: 0, entries: 0, reason }
  try {
    const file = await buildFile(app, userId)
    Object.assign(run, { name: file.name, bytes: file.body.length, entries: file.entries })
    const d = cfg.destination
    if (d.type === 'server') {
      if (file.body.length > SERVER_COPY_MAX_BYTES) throw new Error('This vault is too large to keep a copy on the server; choose S3 or WebDAV.')
      await app.store.put({ pk: userPk(userId), sk: `${BKCOPY_PREFIX}${run.id}`, id: run.id, name: file.name, at, bytes: file.body.length, body: file.body.toString('utf8') })
    } else {
      if (!app.config.personalBackup.remote) throw new Error('This server keeps personal backups on the server only.')
      if (d.type === 's3') await s3Object(s3TargetOf(app, userId, d), 'PUT', `${d.prefix}${file.name}`, file.body, transportFor(app))
      else await webdav(app, userId, d, 'PUT', file.name, file.body)
    }
    run.ok = true
  } catch (err) {
    run.error = describe(err)
  }
  await app.store.put({ pk: userPk(userId), sk: `${BKRUN_PREFIX}${run.id}`, ...run })
  await prune(app, userId, cfg)
  if (reason === 'scheduled' || cfg.nextRunAt !== null) {
    const next = nextRun(cfg.schedule, app.now())
    await app.store.put({ pk: userPk(userId), sk: BKCFG_SK, ...cfg, nextRunAt: next })
    if (next === null) await app.store.delete(SYSTEM_PK, bkdueSk(userId))
    else await app.store.put({ pk: SYSTEM_PK, sk: bkdueSk(userId), userId, nextRunAt: next })
  }
  return run
}

/** Keeps the newest `keep` copies at the current destination, and the last
 *  runs in the history. Remote deletions are best effort. */
async function prune(app: App, userId: string, cfg: BackupConfig): Promise<void> {
  const keep = cfg.destination.type === 'server' ? Math.min(cfg.schedule.keep, SERVER_KEEP_MAX) : cfg.schedule.keep
  if (cfg.destination.type === 'server') {
    const copies = (await app.store.query(userPk(userId), BKCOPY_PREFIX)).sort((a, b) => a.sk.localeCompare(b.sk))
    for (const c of copies.slice(0, Math.max(0, copies.length - keep))) await app.store.delete(c.pk, c.sk)
  }
  const runs = (await app.store.query(userPk(userId), BKRUN_PREFIX)).sort((a, b) => a.sk.localeCompare(b.sk))
  if (cfg.destination.type !== 'server') {
    const label = destinationLabel(cfg.destination)
    const here = runs.filter((r) => r['ok'] && r['destination'] === label && !r['removed'])
    for (const r of here.slice(0, Math.max(0, here.length - keep))) {
      try {
        const d = cfg.destination
        if (d.type === 's3') await s3Object(s3TargetOf(app, userId, d), 'DELETE', `${d.prefix}${String(r['name'])}`, undefined, transportFor(app))
        else if (d.type === 'webdav') await webdav(app, userId, d, 'DELETE', String(r['name']))
        await app.store.put({ ...r, removed: true })
      } catch { /* tried again after the next run */ }
    }
  }
  for (const r of runs.slice(0, Math.max(0, runs.length - RUNS_KEPT))) await app.store.delete(r.pk, r.sk)
}

/** The newest backup, fetched back from wherever it went: for Test restore. */
export async function fetchLatest(app: App, userId: string): Promise<{ name: string; body: string } | null> {
  const cfg = await getConfig(app, userId)
  const d = cfg.destination
  if (d.type === 'server') {
    const copies = (await app.store.query(userPk(userId), BKCOPY_PREFIX)).sort((a, b) => b.sk.localeCompare(a.sk))
    return copies[0] ? { name: String(copies[0]['name']), body: String(copies[0]['body']) } : null
  }
  const label = destinationLabel(d)
  const runs = (await app.store.query(userPk(userId), BKRUN_PREFIX)).filter((r) => r['ok'] && r['destination'] === label && !r['removed'])
    .sort((a, b) => b.sk.localeCompare(a.sk))
  const last = runs[0]
  if (!last) return null
  const name = String(last['name'])
  const body = d.type === 's3'
    ? await s3Object(s3TargetOf(app, userId, d), 'GET', `${d.prefix}${name}`, undefined, transportFor(app))
    : await webdav(app, userId, d, 'GET', name)
  return { name, body: body.toString('utf8') }
}

// ── The timer ─────────────────────────────────────────────────────────────

let ticking = false

/** Runs every schedule that has fallen due. One at a time; a slow
 *  destination delays the others rather than piling up connections. */
export async function tick(app: App): Promise<number> {
  if (ticking) return 0
  ticking = true
  let ran = 0
  try {
    const due = (await app.store.query(SYSTEM_PK, BKDUE_PREFIX)).filter((r) => Number(r['nextRunAt']) <= app.now())
    for (const r of due) {
      await runBackup(app, String(r['userId']), 'scheduled')
      ran++
    }
  } finally {
    ticking = false
  }
  return ran
}

/** Validates a destination URL as it is saved, with the same rules used when
 *  connecting. */
export function checkUrl(app: App, url: string): string {
  return checkDestinationUrl(url, app.config.personalBackup.allowPrivate).toString()
}
