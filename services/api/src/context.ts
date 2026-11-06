// What a request carries once it has been authenticated.

import { type LambdaEvent, unauthorized } from './http.js'
import type { Config } from './config.js'
import { userPk } from './keys.js'
import type { SiteConfig } from './site.js'
import type { Store } from './store.js'
import { bearerFrom, verifyToken } from './tokens.js'

export interface App {
  store: Store
  config: Config
  /** Injected so tests can pin the clock. */
  now: () => number
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
