// The breach check's relay (D5, decisions/0019). The browser hashes each
// password with SHA-1 and asks for the 5-character prefix only; this server
// fetches that range from Pwned Passwords (k-anonymity: hundreds of suffixes
// come back, padded so the response size says nothing) and returns it. The
// browser compares suffixes itself. Neither this server nor Pwned Passwords
// learns a password or its full hash.
//
// Relayed rather than fetched by the page: the page's Content-Security-Policy
// allows no third-party origin, and keeping it that way is worth a hop.

import type { App } from './context.js'
import { HttpError, type LambdaResponse, badRequest, json } from './http.js'
import { enforce, type Limit } from './ratelimit.js'

const PREFIX = /^[0-9A-F]{5}$/
const CACHE_MS = 60 * 60_000
const CACHE_MAX = 5000
const MAX_BYTES = 1024 * 1024
/** A vault of a few thousand passwords checks in one go. */
export const BREACH_LIMIT: Limit = { max: 3000, windowSeconds: 3600 }

const cache = new Map<string, { at: number; body: string }>()

export async function breachRange(app: App, userId: string, prefix: string): Promise<LambdaResponse> {
  if (!app.config.breachCheck.enabled) throw new HttpError(503, 'unavailable', 'The breach check is turned off on this server (BREACH_CHECK).')
  const p = prefix.toUpperCase()
  if (!PREFIX.test(p)) throw badRequest('prefix must be 5 hexadecimal characters.')
  await enforce(app.store, 'breach', userId, BREACH_LIMIT, app.now())

  const hit = cache.get(p)
  if (hit && app.now() - hit.at < CACHE_MS) return json(200, { range: hit.body })

  let body: string
  try {
    const res = await fetch(`${app.config.breachCheck.url}${p}`, {
      headers: { 'add-padding': 'true', 'user-agent': 'vault-breach-check' },
      redirect: 'error', signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`status ${res.status}`)
    body = await res.text()
    if (body.length > MAX_BYTES) throw new Error('response too large')
  } catch (err) {
    throw new HttpError(502, 'unavailable', `The breach database could not be reached (${(err as Error).message}). Try again later.`)
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string)
  cache.set(p, { at: app.now(), body })
  return json(200, { range: body })
}

/** Tests only. */
export function clearBreachCache(): void { cache.clear() }
