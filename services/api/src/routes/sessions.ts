// The account's signed-in devices: list them, name them, sign one out.
//
// A device is a family of refresh-token records sharing one `sid` (see
// SessionRecord in auth.ts). Signing a device out deletes its record, so its
// refresh token stops working at once; an access token it already holds
// lasts out its fifteen minutes, as with every other revocation.

import { requireSession, type App } from '../context.js'
import { type LambdaEvent, type LambdaResponse, badRequest, json, notFound, parseJsonBody } from '../http.js'
import { SESSION_PREFIX, userPk } from '../keys.js'
import { recordActivity } from './activity.js'
import type { SessionRecord } from './auth.js'

export const MAX_DEVICE_NAME = 40

const sidOf = (r: SessionRecord) => r.sid ?? r.sk.slice(SESSION_PREFIX.length)

async function live(app: App, userId: string): Promise<SessionRecord[]> {
  const now = Math.floor(app.now() / 1000)
  const all = (await app.store.query(userPk(userId), SESSION_PREFIX)) as SessionRecord[]
  return all.filter((r) => typeof r.expiresAt !== 'number' || r.expiresAt > now)
}

export async function list(app: App, event: LambdaEvent): Promise<LambdaResponse> {
  const { userId, sid: current } = requireSession(app, event)
  const sessions = (await live(app, userId)).map((r) => ({
    id: sidOf(r),
    device: r.device ?? 'Unknown device',
    ...(r.name ? { name: r.name } : {}),
    ip: r.ip ?? '',
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt ?? r.createdAt,
    current: sidOf(r) === current,
  }))
  sessions.sort((a, b) => Number(b.current) - Number(a.current) || b.lastUsedAt.localeCompare(a.lastUsedAt))
  return json(200, { sessions })
}

export async function rename(app: App, userId: string, event: LambdaEvent, sid: string): Promise<LambdaResponse> {
  const body = parseJsonBody<{ name?: unknown }>(event)
  if (typeof body.name !== 'string') throw badRequest('name is required.')
  const name = body.name.trim()
  if (name.length > MAX_DEVICE_NAME) throw badRequest(`A device name is at most ${MAX_DEVICE_NAME} characters.`)
  const records = (await live(app, userId)).filter((r) => sidOf(r) === sid)
  if (!records.length) throw notFound()
  for (const r of records) {
    const { name: _old, ...rest } = r
    await app.store.put(name ? { ...rest, name } : rest)
  }
  return json(200, { ok: true })
}

export async function revoke(app: App, userId: string, event: LambdaEvent, sid: string): Promise<LambdaResponse> {
  const records = (await live(app, userId)).filter((r) => sidOf(r) === sid)
  if (!records.length) throw notFound()
  for (const r of records) await app.store.delete(r.pk, r.sk)
  await recordActivity(app, userId, 'revoke-session', event)
  return json(200, { ok: true })
}
