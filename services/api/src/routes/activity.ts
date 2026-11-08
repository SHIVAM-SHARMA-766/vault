// Security-relevant events, kept for ninety days and then removed by the
// table's TTL at no charge.
//
// What is recorded is deliberately thin: what happened, when, and from where.
// No entry names, because the server cannot read them, and nothing that would
// make the log more sensitive than the ciphertext beside it.

import { randomUUID } from 'node:crypto'

import type { App } from '../context.js'
import type { LambdaEvent } from '../http.js'
import { activitySk, userPk } from '../keys.js'
import { getSettings } from '../system.js'

export type ActivityKind =
  | 'register'
  | 'login'
  | 'recovery-login'
  | 'change-password'
  | 'rotate-recovery-key'
  | 'enrol-identity'
  | 'reset-password-with-recovery-key'
  | 'enable-2fa'
  | 'disable-2fa'
  | 'regenerate-2fa-recovery-codes'
  | 'used-2fa-recovery-code'
  | 'revoke-session'
  | 'emergency-request'
  | 'emergency-access'


/** Best effort. A failure to record an event must never fail the operation
 *  that succeeded — losing a log line is far better than telling a user their
 *  password change did not work when it did. */
export async function recordActivity(
  app: App,
  userId: string,
  kind: ActivityKind,
  event: LambdaEvent,
): Promise<void> {
  const at = new Date(app.now()).toISOString()
  try {
    await app.store.put({
      pk: userPk(userId),
      sk: activitySk(at, randomUUID().slice(0, 8)),
      kind,
      at,
      ip: event.requestContext.http.sourceIp,
      userAgent: (event.requestContext.http.userAgent ?? '').slice(0, 200),
      expiresAt: Math.floor(app.now() / 1000) + (await getSettings(app)).policy.activityDays * 86_400,
    })
  } catch (err) {
    console.error('failed to record activity', kind, err)
  }
}
