// What a request carries once it has been authenticated.

import { type LambdaEvent, unauthorized } from './http.js'
import type { Config } from './config.js'
import { userPk } from './keys.js'
import type { Store } from './store.js'
import { bearerFrom, verifyToken } from './tokens.js'

export interface App {
  store: Store
  config: Config
  /** Injected so tests can pin the clock. */
  now: () => number
  allowRegistration: boolean
}

export function requireUser(app: App, event: LambdaEvent): string {
  const token = bearerFrom(event.headers)
  if (!token) throw unauthorized()
  const payload = verifyToken(token, 'access', app.config.tokenKey, app.now())
  if (!payload) throw unauthorized()
  return payload.sub
}

export const partitionFor = (userId: string) => userPk(userId)
