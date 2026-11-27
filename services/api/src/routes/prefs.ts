// An account's preferences: theme, auto-lock, clipboard clearing, generator
// defaults. Sealed under the vault key like an entry, so the server keeps
// them for every device without learning even how long someone likes their
// passwords. One small blob per account; the client owns its shape.

import type { App } from '../context.js'
import { type LambdaEvent, type LambdaResponse, json, parseJsonBody } from '../http.js'
import { PREFS_SK, userPk } from '../keys.js'
import { requireSealed } from '../validate.js'

/** Settings, the generator history and a person's item templates (twenty
 *  templates of twenty fields fit with room to spare); anything bigger is not
 *  preferences. */
export const PREFS_MAX_BYTES = 48 * 1024

export async function getPrefs(app: App, userId: string): Promise<LambdaResponse> {
  const item = await app.store.get(userPk(userId), PREFS_SK)
  return json(200, item ? { blob: String(item['blob']), updatedAt: String(item['updatedAt']) } : { blob: null })
}

export async function putPrefs(app: App, userId: string, event: LambdaEvent): Promise<LambdaResponse> {
  const body = parseJsonBody<{ blob?: unknown }>(event)
  const blob = requireSealed(body.blob, 'blob', PREFS_MAX_BYTES)
  const updatedAt = new Date(app.now()).toISOString()
  await app.store.put({ pk: userPk(userId), sk: PREFS_SK, blob, updatedAt })
  return json(200, { updatedAt })
}
