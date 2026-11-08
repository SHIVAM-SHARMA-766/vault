// Share links (D3, decisions/0018). One item, sealed in the owner's browser
// with a fresh random key that travels only in the link's #fragment — which
// browsers never send to a server. The server holds ciphertext, an expiry
// and a view limit, and cannot open what it holds.
//
// Opening is a POST, not the page load, so a chat app's link preview does
// not spend a view. Each open is counted atomically; the last allowed view
// deletes the copy.

import type { App } from '../context.js'
import { HttpError, type LambdaEvent, type LambdaResponse, badRequest, conflict, json, notFound, parseJsonBody } from '../http.js'
import { SHARE_META_SK, SHARE_VIEWS_SK, USER_SHARE_PREFIX, sharePk, userPk, userShareSk } from '../keys.js'
import { enforce, type Limit } from '../ratelimit.js'
import { AlreadyExists } from '../store.js'
import { requireSealed } from '../validate.js'
import { recordActivity } from './activity.js'

export const SHARE_EXPIRY_CHOICES = [3600, 86_400, 7 * 86_400, 30 * 86_400] as const
export const SHARE_VIEW_CHOICES = [1, 2, 5, 10, null] as const
export const SHARE_MAX_BYTES = 64 * 1024
export const SHARE_MAX_ACTIVE = 100
/** Index rows outlive their link by a week, so the owner sees "expired". */
const INDEX_GRACE_SECONDS = 7 * 86_400

const CREATE_LIMIT: Limit = { max: 30, windowSeconds: 3600 }
const OPEN_LIMIT: Limit = { max: 30, windowSeconds: 600 }

/** 16 random bytes, base64url: chosen by the client so the id can be bound
 *  into the ciphertext as associated data. */
const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/
const requireShareId = (v: unknown): string => {
  if (typeof v !== 'string' || !ID_PATTERN.test(v)) throw badRequest('id must be 16 random bytes, base64url.')
  return v
}

const nowS = (app: App) => Math.floor(app.now() / 1000)

export async function createShare(app: App, userId: string, event: LambdaEvent): Promise<LambdaResponse> {
  const b = parseJsonBody<Record<string, unknown>>(event)
  const id = requireShareId(b['id'])
  const blob = requireSealed(b['blob'], 'blob', SHARE_MAX_BYTES)
  // The item's name, sealed with the owner's vault key, for their own list.
  const labelBlob = requireSealed(b['labelBlob'], 'labelBlob', 2048)
  const expiresIn = b['expiresIn']
  if (!(SHARE_EXPIRY_CHOICES as readonly unknown[]).includes(expiresIn)) throw badRequest(`expiresIn must be one of: ${SHARE_EXPIRY_CHOICES.join(', ')} (seconds).`)
  const maxViews = b['maxViews'] ?? null
  if (!(SHARE_VIEW_CHOICES as readonly unknown[]).includes(maxViews)) throw badRequest('maxViews must be 1, 2, 5, 10 or null.')

  await enforce(app.store, 'share-create', userId, CREATE_LIMIT, app.now())
  const active = (await app.store.query(userPk(userId), USER_SHARE_PREFIX))
    .filter((r) => Number(r['expiresAt']) - INDEX_GRACE_SECONDS > nowS(app))
  if (active.length >= SHARE_MAX_ACTIVE) throw conflict(`You have ${SHARE_MAX_ACTIVE} live links. Revoke some first.`)

  const createdAt = new Date(app.now()).toISOString()
  const expiresAt = nowS(app) + (expiresIn as number)
  try {
    await app.store.put({ pk: sharePk(id), sk: SHARE_META_SK, ownerId: userId, blob, createdAt, expiresAt, maxViews }, { mustNotExist: true })
  } catch (err) {
    if (err instanceof AlreadyExists) throw conflict('That id is taken. Try again.')
    throw err
  }
  await app.store.put({
    pk: userPk(userId), sk: userShareSk(id), shareId: id, labelBlob, createdAt,
    linkExpiresAt: expiresAt, maxViews, expiresAt: expiresAt + INDEX_GRACE_SECONDS,
  })
  await recordActivity(app, userId, 'share-create', event)
  return json(201, { id, expiresAt: new Date(expiresAt * 1000).toISOString(), maxViews })
}

/** Anyone holding the link. Every refusal is the same 404: expired, used
 *  up, revoked and never existed look alike. */
export async function openShare(app: App, event: LambdaEvent, id: string): Promise<LambdaResponse> {
  await enforce(app.store, 'share-open', event.requestContext.http.sourceIp, OPEN_LIMIT, app.now())
  const gone = () => new HttpError(404, 'not_found', 'This link has expired, was used up, or was revoked.')
  if (!ID_PATTERN.test(id)) throw gone()
  const meta = await app.store.get(sharePk(id), SHARE_META_SK)
  if (!meta || Number(meta['expiresAt']) <= nowS(app)) throw gone()
  const maxViews = meta['maxViews'] as number | null
  const views = await app.store.increment(sharePk(id), SHARE_VIEWS_SK, Number(meta['expiresAt']))
  if (maxViews !== null && views > maxViews) throw gone()
  if (maxViews !== null && views === maxViews) {
    // The last allowed view: the copy goes now, and the counter with it
    // once its own expiry passes.
    await app.store.delete(sharePk(id), SHARE_META_SK)
  }
  await recordActivity(app, String(meta['ownerId']), 'share-open', event)
  return json(200, {
    blob: meta['blob'],
    expiresAt: new Date(Number(meta['expiresAt']) * 1000).toISOString(),
    viewsLeft: maxViews === null ? null : maxViews - views,
  })
}

export async function listShares(app: App, userId: string): Promise<LambdaResponse> {
  const rows = await app.store.query(userPk(userId), USER_SHARE_PREFIX)
  const shares = await Promise.all(rows.map(async (r) => {
    const id = String(r['shareId'])
    const [meta, counter] = await Promise.all([app.store.get(sharePk(id), SHARE_META_SK), app.store.get(sharePk(id), SHARE_VIEWS_SK)])
    const views = Number(counter?.['count'] ?? 0)
    const linkExpiresAt = Number(r['linkExpiresAt'])
    const status = r['revoked'] ? 'revoked' : linkExpiresAt <= nowS(app) ? 'expired' : meta ? 'live' : 'used'
    return {
      id, labelBlob: r['labelBlob'], createdAt: r['createdAt'], expiresAt: new Date(linkExpiresAt * 1000).toISOString(),
      maxViews: r['maxViews'] ?? null, views, status,
    }
  }))
  shares.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  return json(200, { shares })
}

export async function revokeShare(app: App, userId: string, id: string): Promise<LambdaResponse> {
  const index = ID_PATTERN.test(id) ? await app.store.get(userPk(userId), userShareSk(id)) : null
  if (!index) throw notFound()
  await app.store.delete(sharePk(id), SHARE_META_SK)
  await app.store.put({ ...index, revoked: true })
  return json(200, { ok: true })
}

/** For account deletion: every live copy goes with the account. */
export async function eraseShares(app: App, userId: string): Promise<void> {
  for (const r of await app.store.query(userPk(userId), USER_SHARE_PREFIX)) {
    const id = String(r['shareId'])
    await app.store.delete(sharePk(id), SHARE_META_SK)
    await app.store.delete(sharePk(id), SHARE_VIEWS_SK)
  }
}
