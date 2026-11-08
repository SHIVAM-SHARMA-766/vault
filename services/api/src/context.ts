// What a request carries once it has been authenticated.

import { type LambdaEvent, unauthorized } from './http.js'
import type { Config } from './config.js'
import type { Mailer } from './mail.js'
import { SESSION_PREFIX, userPk } from './keys.js'
import type { SiteConfig } from './site.js'
import type { Store } from './store.js'
import { bearerFrom, verifyToken } from './tokens.js'

export interface App {
  store: Store
  config: Config
  /** Injected so tests can pin the clock. */
  now: () => number
  /** Present when SMTP is configured (mail.ts). */
  mailer?: Mailer
  /** Forces registration open regardless of the stored setting. Exists for
   *  bootstrapping the first account, before anyone can reach the admin panel
   *  to open it; scripts/registration.sh manages it. */
  allowRegistration: boolean
  /** Email digests (see identity.ts) of the accounts allowed into the admin
   *  routes. Digests rather than addresses, so the running process holds the
   *  same thing the table does. Empty means nobody is an admin. */
  adminDigests: ReadonlySet<string>
  /** Where the public website's templates are and where it is rendered to.
   *  Absent where website editing is not set up; those routes then refuse. */
  site?: SiteConfig
}

export function requireUser(app: App, event: LambdaEvent): string {
  return requireSession(app, event).userId
}

/** The caller and, for tokens issued since sessions carried one, the device
 *  session the token belongs to. */
export function requireSession(app: App, event: LambdaEvent): { userId: string; sid?: string } {
  const token = bearerFrom(event.headers)
  if (!token) throw unauthorized()
  const payload = verifyToken(token, 'access', app.config.tokenKey, app.now())
  if (!payload) throw unauthorized()
  return { userId: payload.sub, ...(typeof payload.sid === 'string' ? { sid: payload.sid } : {}) }
}

export const partitionFor = (userId: string) => userPk(userId)

/** As requireSession, and the session must still exist: a signed-out device,
 *  "sign out everywhere", a replayed refresh token, a disabled or deleted
 *  account all stop at once instead of when the access token expires. One
 *  partition read per request (the account's own session rows). */
export async function requireLiveSession(app: App, event: LambdaEvent): Promise<{ userId: string; sid?: string }> {
  const session = requireSession(app, event)
  const now = Math.floor(app.now() / 1000)
  const rows = await app.store.query(userPk(session.userId), SESSION_PREFIX)
  const alive = rows.some((r) => {
    if (typeof r['expiresAt'] === 'number' && r['expiresAt'] <= now) return false
    if (!session.sid) return true // tokens from before sessions carried an id
    return (typeof r['sid'] === 'string' ? r['sid'] : r.sk.slice(SESSION_PREFIX.length)) === session.sid
  })
  if (!alive) throw unauthorized()
  return session
}
