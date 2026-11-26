// Daily counts for the admin dashboard (admin console phase 2): sign-ins,
// failed sign-ins and new accounts per day. Counters only: no account, no
// address, no network address. Kept 400 days.

import type { App } from './context.js'
import type { LambdaResponse } from './http.js'
import { HttpError } from './http.js'

export const STATS_PK = 'STATS'
export const STAT_KINDS = ['signin', 'signin-failed', 'signup'] as const
export type StatKind = (typeof STAT_KINDS)[number]
const KEEP_DAYS = 400

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** Best effort: a count that fails to record must never fail the request. */
export async function recordStat(app: App, kind: StatKind): Promise<void> {
  try {
    await app.store.increment(STATS_PK, `${kind}#${day(app.now())}`, Math.floor(app.now() / 1000) + KEEP_DAYS * 86_400)
  } catch { /* not counted */ }
}

/** The last `days` days, oldest first, every kind, zeros where nothing happened. */
export async function dailyStats(app: App, days: number): Promise<{ day: string; signin: number; 'signin-failed': number; signup: number }[]> {
  const out = []
  const counts = new Map<string, number>()
  for (const kind of STAT_KINDS) {
    for (const r of await app.store.query(STATS_PK, `${kind}#`)) counts.set(r.sk, Number(r['count'] ?? 0))
  }
  for (let i = days - 1; i >= 0; i--) {
    const d = day(app.now() - i * 86_400_000)
    out.push({ day: d, signin: counts.get(`signin#${d}`) ?? 0, 'signin-failed': counts.get(`signin-failed#${d}`) ?? 0, signup: counts.get(`signup#${d}`) ?? 0 })
  }
  return out
}

/** Wraps a sign-in route: a success counts as a sign-in, a refused password
 *  as a failed one. Other failures (rate limits, bad requests) count as
 *  neither. */
export function countedSignIn(app: App, handler: () => Promise<LambdaResponse>, success: StatKind | null = 'signin'): Promise<LambdaResponse> {
  return handler().then(async (res) => {
    if (res.statusCode === 200 || res.statusCode === 201) { if (success) await recordStat(app, success) }
    else if (res.statusCode === 401 && /"invalid_credentials"/.test(res.body ?? '')) await recordStat(app, 'signin-failed')
    return res
  }, async (err: unknown) => {
    if (err instanceof HttpError && err.code === 'invalid_credentials') await recordStat(app, 'signin-failed')
    throw err
  })
}
