// The notification centre (E10): a short inbox per account for things that
// happened while they were away. The server cannot read vault contents, so a
// notification carries ids and labels the server already holds (a member's
// label, an address), never an item's name; the app fills names in from what
// it can decrypt. Best effort, like activity: failing to notify never fails
// the action. Kept for the server's activity retention, at most 200 per account.

import { randomUUID } from 'node:crypto'

import type { App } from './context.js'
import { HttpError, type LambdaEvent, type LambdaResponse, json, parseJsonBody } from './http.js'
import { NOTE_PREFIX, noteSk, userPk } from './keys.js'
import { getSettings } from './system.js'

export type NoteKind =
  | 'share-opened'        // one of my share links was opened
  | 'access-request'      // someone asks for a collection I manage
  | 'access-granted'      // my request was approved
  | 'access-denied'       // my request was turned down
  | 'access-ended'        // a check-out ran out
  | 'sensitive-opened'    // someone opened a sensitive item in my organization
  | 'org-invite'          // I was invited to an organization
  | 'member-accepted'     // someone accepted my organization's invitation; confirm them
  | 'backup-failed'       // my scheduled backup failed
  | 'emergency-request'   // my trusted contact asked for access

const MAX_NOTES = 200

export async function addNote(app: App, userId: string, kind: NoteKind, data: Record<string, string | number | boolean | null> = {}): Promise<void> {
  try {
    const at = new Date(app.now()).toISOString()
    const days = (await getSettings(app)).policy.activityDays
    await app.store.put({ pk: userPk(userId), sk: noteSk(at, randomUUID().slice(0, 8)), kind, at, data, expiresAt: Math.floor(app.now() / 1000) + days * 86_400 })
    const rows = await app.store.query(userPk(userId), NOTE_PREFIX)
    for (const old of rows.slice(0, Math.max(0, rows.length - MAX_NOTES))) await app.store.delete(old.pk, old.sk)
  } catch (err) {
    console.error('notification not recorded', kind, (err as Error).message)
  }
}

export async function addNotes(app: App, userIds: Iterable<string>, kind: NoteKind, data: Record<string, string | number | boolean | null> = {}): Promise<void> {
  for (const u of new Set(userIds)) await addNote(app, u, kind, data)
}

export async function listNotes(app: App, userId: string): Promise<LambdaResponse> {
  const rows = await app.store.query(userPk(userId), NOTE_PREFIX)
  const now = Math.floor(app.now() / 1000)
  const notes = rows.filter((r) => typeof r['expiresAt'] !== 'number' || r['expiresAt'] > now).reverse().slice(0, 100)
    .map((r) => ({ id: r.sk.slice(NOTE_PREFIX.length), kind: r['kind'], at: r['at'], read: r['read'] === true, data: r['data'] ?? {} }))
  return json(200, { notes, unread: notes.filter((n) => !n.read).length })
}

/** Marks some or all as read: `{ all: true }` or `{ ids: [...] }`. */
export async function readNotes(app: App, userId: string, event: LambdaEvent): Promise<LambdaResponse> {
  const b = parseJsonBody<{ all?: unknown; ids?: unknown }>(event)
  const ids = Array.isArray(b.ids) ? new Set(b.ids.filter((x): x is string => typeof x === 'string')) : null
  if (b.all !== true && !ids) throw new HttpError(400, 'bad_request', 'Send { all: true } or { ids: [...] }.')
  for (const r of await app.store.query(userPk(userId), NOTE_PREFIX)) {
    if (r['read'] === true) continue
    if (b.all === true || ids!.has(r.sk.slice(NOTE_PREFIX.length))) await app.store.put({ ...r, read: true })
  }
  return listNotes(app, userId)
}
