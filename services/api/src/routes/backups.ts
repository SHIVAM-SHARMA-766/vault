// Settings → Backups: a person's own schedule and destination, runs, copies
// kept on the server, and the newest copy fetched back for a test restore.
// See decisions/0017 and personal-backup.ts.

import type { App } from '../context.js'
import { CLOUD_PROVIDERS, type CloudProvider, CloudError, connectUrl, finishConnect, providerConfigured } from '../cloud-drive.js'
import { EgressRefused } from '../egress.js'
import { type LambdaEvent, type LambdaResponse, badRequest, json, notFound, parseJsonBody, redirect } from '../http.js'
import { userPk } from '../keys.js'
import { enforce, type Limit } from '../ratelimit.js'
import {
  BKCOPY_PREFIX, BKRUN_PREFIX, FREQUENCIES, SERVER_KEEP_MAX, type Destination, type Frequency, type Schedule,
  checkUrl, connectCloud, fetchLatest, getConfig, publicDestination, runBackup, saveConfig,
} from '../personal-backup.js'

/** Building and uploading a backup is real work; a few an hour is plenty. */
export const RUN_LIMIT: Limit = { max: 6, windowSeconds: 60 * 60 }

export async function getBackups(app: App, userId: string): Promise<LambdaResponse> {
  const cfg = await getConfig(app, userId)
  const runs = (await app.store.query(userPk(userId), BKRUN_PREFIX)).sort((a, b) => b.sk.localeCompare(a.sk))
    .map(({ pk: _pk, sk: _sk, removed: _r, ...r }) => r)
  const copies = (await app.store.query(userPk(userId), BKCOPY_PREFIX)).sort((a, b) => b.sk.localeCompare(a.sk))
    .map((c) => ({ id: String(c['id']), name: String(c['name']), at: String(c['at']), bytes: Number(c['bytes']) }))
  return json(200, {
    schedule: cfg.schedule,
    destination: publicDestination(cfg.destination),
    nextRunAt: cfg.nextRunAt ? new Date(cfg.nextRunAt).toISOString() : null,
    runs, copies,
    remoteAllowed: app.config.personalBackup.remote,
    // Google Drive and OneDrive, when the operator registered their apps (decisions/0024).
    cloud: { gdrive: providerConfigured(app, 'gdrive'), onedrive: providerConfigured(app, 'onedrive') },
    serverKeepMax: SERVER_KEEP_MAX,
  })
}

const int = (v: unknown, min: number, max: number, field: string): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw badRequest(`${field} must be a whole number from ${min} to ${max}.`)
  return v
}
const text = (v: unknown, max: number, field: string, required = true): string => {
  if (v === undefined && !required) return ''
  if (typeof v !== 'string') throw badRequest(`${field} must be text.`)
  const t = v.trim()
  if (required && !t) throw badRequest(`${field} is required.`)
  if (t.length > max || /[\u0000-\u001f]/.test(t)) throw badRequest(`${field} is not valid.`)
  return t
}

export function requireSchedule(v: unknown): Schedule {
  if (!v || typeof v !== 'object') throw badRequest('schedule must be an object.')
  const s = v as Record<string, unknown>
  if (!FREQUENCIES.includes(s['frequency'] as Frequency)) throw badRequest(`schedule.frequency must be one of: ${FREQUENCIES.join(', ')}.`)
  return {
    frequency: s['frequency'] as Frequency,
    hour: int(s['hour'], 0, 23, 'schedule.hour'),
    weekday: int(s['weekday'] ?? 0, 0, 6, 'schedule.weekday'),
    tzOffsetMinutes: int(s['tzOffsetMinutes'] ?? 0, -720, 840, 'schedule.tzOffsetMinutes'),
    keep: int(s['keep'], 1, 30, 'schedule.keep'),
  }
}

function requireDestination(app: App, v: unknown) {
  if (!v || typeof v !== 'object') throw badRequest('destination must be an object.')
  const d = v as Record<string, unknown>
  if (d['type'] === 'server') return { type: 'server' as const }
  if (CLOUD_PROVIDERS.includes(d['type'] as CloudProvider)) {
    if (!providerConfigured(app, d['type'] as CloudProvider)) throw badRequest('That cloud drive is not set up on this server.')
    return { type: d['type'] as CloudProvider }
  }
  if (d['type'] !== 's3' && d['type'] !== 'webdav') throw badRequest('destination.type must be server, s3, webdav, gdrive or onedrive.')
  if (!app.config.personalBackup.remote) throw badRequest('This server keeps personal backups on the server only.')
  try {
    if (d['type'] === 's3') {
      const prefix = text(d['prefix'], 200, 'destination.prefix', false)
      if (prefix.includes('..') || prefix.startsWith('/')) throw badRequest('destination.prefix is not valid.')
      const bucket = text(d['bucket'], 63, 'destination.bucket')
      if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw badRequest('destination.bucket is not a valid bucket name.')
      const secretKey = text(d['secretKey'], 200, 'destination.secretKey', false)
      return {
        type: 's3' as const, endpoint: checkUrl(app, text(d['endpoint'], 300, 'destination.endpoint')).replace(/\/+$/, ''),
        region: text(d['region'], 40, 'destination.region', false) || 'us-east-1', bucket,
        prefix: prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix,
        accessKey: text(d['accessKey'], 200, 'destination.accessKey'),
        ...(secretKey ? { secretKey } : {}),
      }
    }
    const password = text(d['password'], 300, 'destination.password', false)
    return {
      type: 'webdav' as const, url: checkUrl(app, text(d['url'], 500, 'destination.url')),
      username: text(d['username'], 200, 'destination.username'),
      ...(password ? { password } : {}),
    }
  } catch (err) {
    if (err instanceof EgressRefused) throw badRequest(err.message)
    throw err
  }
}

export async function putConfig(app: App, userId: string, event: LambdaEvent): Promise<LambdaResponse> {
  const body = parseJsonBody<{ schedule?: unknown; destination?: unknown }>(event)
  const schedule = requireSchedule(body.schedule)
  const destination = requireDestination(app, body.destination ?? { type: 'server' })
  try {
    const cfg = await saveConfig(app, userId, schedule, destination as Destination)
    return json(200, { nextRunAt: cfg.nextRunAt ? new Date(cfg.nextRunAt).toISOString() : null, destination: publicDestination(cfg.destination) })
  } catch (err) {
    if (err instanceof EgressRefused) throw badRequest(err.message)
    throw err
  }
}

/** Step one of connecting a drive: the provider's consent page. */
export async function connect(app: App, userId: string, provider: string): Promise<LambdaResponse> {
  if (!CLOUD_PROVIDERS.includes(provider as CloudProvider) || !providerConfigured(app, provider as CloudProvider)) throw notFound()
  return json(200, { url: await connectUrl(app, userId, provider as CloudProvider) })
}

/** Step two: the provider sends the browser back here. The person's drive
 *  becomes their destination, and they return to Settings → Backups. */
export async function oauthCallback(app: App, event: LambdaEvent): Promise<LambdaResponse> {
  const q = new URLSearchParams(event.rawQueryString ?? '')
  const back = (fragment: string) => redirect(`${app.config.origin}/app/settings/backups#${fragment}`)
  if (q.get('error')) return back(`cloud-error=${encodeURIComponent(q.get('error') === 'access_denied' ? 'You did not allow Vault access.' : 'The provider reported an error.')}`)
  try {
    const connected = await finishConnect(app, q.get('state') ?? '', q.get('code') ?? '')
    await connectCloud(app, connected)
    return back(`cloud=${connected.provider}`)
  } catch (err) {
    return back(`cloud-error=${encodeURIComponent(err instanceof CloudError ? err.message : 'The drive could not be connected. Try again.')}`)
  }
}

export async function runNow(app: App, userId: string): Promise<LambdaResponse> {
  await enforce(app.store, 'backup', userId, RUN_LIMIT, app.now())
  const run = await runBackup(app, userId, 'manual')
  if (!run) throw notFound()
  return run.ok ? json(200, { run }) : json(502, { error: 'destination', message: run.error ?? 'The backup failed.', run })
}

export async function getCopy(app: App, userId: string, id: string): Promise<LambdaResponse> {
  const item = await app.store.get(userPk(userId), `${BKCOPY_PREFIX}${id}`)
  if (!item) throw notFound()
  return json(200, { name: String(item['name']), body: String(item['body']) })
}

export async function deleteCopy(app: App, userId: string, id: string): Promise<LambdaResponse> {
  const item = await app.store.get(userPk(userId), `${BKCOPY_PREFIX}${id}`)
  if (!item) throw notFound()
  await app.store.delete(item.pk, item.sk)
  return json(200, { ok: true })
}

export async function latest(app: App, userId: string): Promise<LambdaResponse> {
  // Fetching from a person's destination is outbound work too.
  await enforce(app.store, 'backup-test', userId, RUN_LIMIT, app.now())
  try {
    const found = await fetchLatest(app, userId)
    if (!found) throw notFound()
    return json(200, found)
  } catch (err) {
    if (err instanceof Error && !('status' in err)) return json(502, { error: 'destination', message: err.message.slice(0, 200) })
    throw err
  }
}
