// Confirming who you are again before a sensitive admin action (admin console
// phase 3), as GitHub's "sudo mode": a sign-in, or the master password typed
// again, counts for ten minutes on that device. Changing roles, deleting or
// offboarding accounts, resetting someone's sign-in, and changing server
// settings ask for it.

import type { App } from './context.js'
import { HttpError, type LambdaEvent, type LambdaResponse, badRequest, invalidCredentials, json, parseJsonBody } from './http.js'
import { PROFILE_SK, userPk } from './keys.js'
import { requireSession } from './context.js'
import { enforce } from './ratelimit.js'
import { AUTH_LIMIT } from './ratelimit.js'
import { verifyAuthKey } from './verifier.js'

export const SUDO_SECONDS = 10 * 60
const sudoSk = (sid: string) => `SUDO#${sid}`

/** Starts (or restarts) the window for one device. */
export async function grantSudo(app: App, userId: string, sid: string): Promise<number> {
  const until = Math.floor(app.now() / 1000) + SUDO_SECONDS
  await app.store.put({ pk: userPk(userId), sk: sudoSk(sid), expiresAt: until })
  return until
}

/** Refuses unless this device confirmed who it is in the last ten minutes. */
export async function requireSudo(app: App, event: LambdaEvent): Promise<void> {
  const { userId, sid } = requireSession(app, event)
  const row = sid ? await app.store.get(userPk(userId), sudoSk(sid)) : null
  if (!row || Number(row['expiresAt']) <= Math.floor(app.now() / 1000)) {
    throw new HttpError(403, 'reauth_required', 'Confirm your master password to do this. It counts for ten minutes.')
  }
}

/** POST /api/auth/reauth: the master password's proof, as at sign-in. */
export async function reauth(app: App, userId: string, event: LambdaEvent): Promise<LambdaResponse> {
  const { sid } = requireSession(app, event)
  if (!sid) throw badRequest('Sign in again first.')
  const authKey = parseJsonBody<{ authKey?: unknown }>(event).authKey
  if (typeof authKey !== 'string' || !authKey) throw badRequest('authKey is required.')
  await enforce(app.store, 'reauth', userId, AUTH_LIMIT, app.now())
  const profile = await app.store.get(userPk(userId), PROFILE_SK)
  if (!profile || !(await verifyAuthKey(authKey, String(profile['authVerifier'] ?? '')))) throw invalidCredentials()
  return json(200, { until: new Date((await grantSudo(app, userId, sid)) * 1000).toISOString() })
}
