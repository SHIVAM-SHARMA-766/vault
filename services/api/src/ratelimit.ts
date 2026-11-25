// Fixed-window rate limiting, in the same table.
//
// Counters are ordinary items with a TTL, so DynamoDB removes them for free and
// there is nothing to prune. A fixed window is coarser than a sliding one and
// allows a burst across a boundary; that is an accepted trade for not holding
// per-request state.
//
// See docs/threat-model.md, A6.

import { tooManyRequests } from './http.js'
import { ratePk } from './keys.js'
import type { Store } from './store.js'

export interface Limit {
  /** Requests permitted per window. */
  max: number
  windowSeconds: number
}

/** Login and registration. Deliberately strict: an attacker guessing a master
 *  password online should exhaust their patience long before the key space. */
export const AUTH_LIMIT: Limit = { max: 10, windowSeconds: 15 * 60 }

/** The single sign-on round trip (decisions/0021): starting it and reading a
 *  ticket. Neither checks a secret anyone could guess (a ticket is 256 random
 *  bits), so they are kept off AUTH_LIMIT, where the sign-in that follows is
 *  counted, and bounded only against floods. */
export const SSO_LIMIT: Limit = { max: 30, windowSeconds: 15 * 60 }

/** Everything an authenticated client does. Loose enough that ordinary use
 *  never notices, tight enough to bound a runaway client against the 25
 *  provisioned write units. */
export const API_LIMIT: Limit = { max: 300, windowSeconds: 60 }

export async function enforce(
  store: Store,
  bucket: string,
  subject: string,
  limit: Limit,
  now = Date.now(),
): Promise<void> {
  const nowSeconds = Math.floor(now / 1000)
  const window = Math.floor(nowSeconds / limit.windowSeconds)
  const expiresAt = (window + 2) * limit.windowSeconds

  const count = await store.increment(ratePk(bucket), `${subject}#${window}`, expiresAt)
  if (count > limit.max) {
    throw tooManyRequests((window + 1) * limit.windowSeconds - nowSeconds)
  }
}
