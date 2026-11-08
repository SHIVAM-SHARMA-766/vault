// Data retention (G7). Every log row is written with an expiry from the server
// policy, and the store's sweep removes it then. When an administrator
// shortens a retention period, rows written under the longer one would linger
// until their old expiry; this pass removes them. Lengthening a period applies
// to rows written from then on — what was already removed stays removed.

import type { App } from './context.js'
import {
  ACTIVITY_PREFIX,
  AUDIT_PREFIX,
  ORG_EVENT_PREFIX,
  SYSTEM_ORG_PREFIX,
  SYSTEM_PK,
  orgPk,
  userPk,
} from './keys.js'
import { getSettings, listRegistry } from './system.js'

/** Deletes rows in `pk` under `prefix` whose `at` is older than `days`.
 *  Returns how many went. */
async function trim(app: App, pk: string, prefix: string, days: number): Promise<number> {
  const cutoff = new Date(app.now() - days * 86_400_000).toISOString()
  let n = 0
  for (const row of await app.store.query(pk, prefix)) {
    const at = row['at']
    if (typeof at === 'string' && at < cutoff) { await app.store.delete(pk, row.sk); n++ }
  }
  return n
}

export async function applyRetention(app: App): Promise<{ audit: number; activity: number; orgEvents: number }> {
  const { policy } = await getSettings(app)
  const audit = await trim(app, SYSTEM_PK, AUDIT_PREFIX, policy.auditDays)
  let activity = 0
  for (const reg of await listRegistry(app)) activity += await trim(app, userPk(reg.userId), ACTIVITY_PREFIX, policy.activityDays)
  let orgEvents = 0
  for (const org of await app.store.query(SYSTEM_PK, SYSTEM_ORG_PREFIX)) {
    orgEvents += await trim(app, orgPk(org.sk.slice(SYSTEM_ORG_PREFIX.length)), ORG_EVENT_PREFIX, policy.auditDays)
  }
  return { audit, activity, orgEvents }
}
