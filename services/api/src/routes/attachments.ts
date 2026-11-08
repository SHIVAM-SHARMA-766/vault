// File attachments (D2, decisions/0020). The browser encrypts each file with a
// fresh key and keeps that key inside the entry's own sealed content; the
// server stores the ciphertext, its size and when it came. It cannot tell
// which entry a file belongs to, what it is called, or what it holds.

import type { App } from '../context.js'
import { HttpError, type LambdaEvent, type LambdaResponse, badRequest, json, notFound, parseJsonBody } from '../http.js'
import { ATTACHMENT_PREFIX, attachmentSk, isValidId, userPk } from '../keys.js'
import { requireSealed } from '../validate.js'

/** 2 MB of file, sealed and base64url-encoded, stays well under the 4 MB request limit. */
export const ATTACHMENT_MAX_SEALED = 3 * 1024 * 1024
export const ATTACHMENT_QUOTA_BYTES = 100 * 1024 * 1024

export async function putAttachment(app: App, userId: string, event: LambdaEvent, id: string): Promise<LambdaResponse> {
  if (!isValidId(id)) throw badRequest('id must be an identifier.')
  const blob = requireSealed(parseJsonBody<{ blob?: unknown }>(event).blob, 'blob', ATTACHMENT_MAX_SEALED)
  const rows = await app.store.query(userPk(userId), ATTACHMENT_PREFIX)
  if (rows.some((r) => r.sk === attachmentSk(id))) throw new HttpError(409, 'conflict', 'That attachment exists; attachments are never replaced.')
  const used = rows.reduce((n, r) => n + Number(r['bytes'] ?? 0), 0)
  if (used + blob.length > ATTACHMENT_QUOTA_BYTES) {
    throw new HttpError(413, 'too_large', `Attachments are limited to ${ATTACHMENT_QUOTA_BYTES / 1024 / 1024} MB per account; ${Math.round(used / 1024 / 1024)} MB is in use. Remove some first.`)
  }
  await app.store.put({ pk: userPk(userId), sk: attachmentSk(id), bytes: blob.length, blob, createdAt: new Date(app.now()).toISOString() }, { mustNotExist: true })
  return json(201, { id, bytes: blob.length, used: used + blob.length, quota: ATTACHMENT_QUOTA_BYTES })
}

export async function getAttachment(app: App, userId: string, id: string): Promise<LambdaResponse> {
  const row = isValidId(id) ? await app.store.get(userPk(userId), attachmentSk(id)) : null
  if (!row) throw notFound()
  return json(200, { blob: row['blob'] })
}

export async function deleteAttachment(app: App, userId: string, id: string): Promise<LambdaResponse> {
  if (isValidId(id)) await app.store.delete(userPk(userId), attachmentSk(id))
  return json(200, { ok: true })
}

/** How much of the quota is in use, for the editor to say so. */
export async function attachmentUsage(app: App, userId: string): Promise<LambdaResponse> {
  const rows = await app.store.query(userPk(userId), ATTACHMENT_PREFIX)
  return json(200, { used: rows.reduce((n, r) => n + Number(r['bytes'] ?? 0), 0), count: rows.length, quota: ATTACHMENT_QUOTA_BYTES })
}
