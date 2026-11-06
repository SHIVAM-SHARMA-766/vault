// The vault itself.
//
// Every route here moves ciphertext the server cannot read. It validates
// shape, size, and ownership, and nothing else — there is nothing else it
// could validate.

import type { App } from '../context.js'
import { type LambdaEvent, type LambdaResponse, badRequest, conflict, json, notFound, parseJsonBody } from '../http.js'
import {
  ENTRY_PREFIX,
  FOLDER_PREFIX,
  HISTORY_PREFIX,
  entrySk,
  folderSk,
  historyPrefix,
  historySk,
  isValidId,
  userPk,
} from '../keys.js'
import { AlreadyExists, type Item } from '../store.js'
import { requireSealed } from '../validate.js'

/** Older versions of an entry, so a mistaken edit is recoverable. Capped
 *  client-side; the cap is enforced here too, because the client is the thing
 *  an attacker controls and each version consumes the same free capacity. */
const MAX_HISTORY = 20

const view = (item: Item) => ({
  id: String(item['id']),
  blob: String(item['blob']),
  createdAt: String(item['createdAt']),
  updatedAt: String(item['updatedAt']),
})

/** One query returns the whole vault. There is no server-side search, sort, or
 *  filter to paginate by, because the server cannot read any field worth
 *  filtering on. */
export async function getVault(app: App, userId: string): Promise<LambdaResponse> {
  const items = await app.store.query(userPk(userId))
  const entries = items.filter((i) => i.sk.startsWith(ENTRY_PREFIX)).map(view)
  const folders = items.filter((i) => i.sk.startsWith(FOLDER_PREFIX)).map(view)
  return json(200, { entries, folders })
}

async function upsert(
  app: App,
  userId: string,
  event: LambdaEvent,
  id: string,
  sk: (id: string) => string,
): Promise<LambdaResponse> {
  if (!isValidId(id)) throw badRequest('Invalid identifier.')
  const body = parseJsonBody<{ blob?: unknown }>(event)
  const blob = requireSealed(body.blob, 'blob')

  const at = new Date(app.now()).toISOString()
  const existing = await app.store.get(userPk(userId), sk(id))

  await app.store.put({
    pk: userPk(userId),
    sk: sk(id),
    id,
    blob,
    createdAt: existing ? String(existing['createdAt']) : at,
    updatedAt: at,
  })
  return json(existing ? 200 : 201, { id, createdAt: existing?.['createdAt'] ?? at, updatedAt: at })
}

export const putEntry = (app: App, userId: string, event: LambdaEvent, id: string) =>
  upsert(app, userId, event, id, entrySk)

export const putFolder = (app: App, userId: string, event: LambdaEvent, id: string) =>
  upsert(app, userId, event, id, folderSk)

export async function deleteEntry(app: App, userId: string, id: string): Promise<LambdaResponse> {
  if (!isValidId(id)) throw badRequest('Invalid identifier.')
  await app.store.delete(userPk(userId), entrySk(id))
  // History belongs to the entry and goes with it.
  for (const h of await app.store.query(userPk(userId), historyPrefix(id))) {
    await app.store.delete(h.pk, h.sk)
  }
  return json(200, { ok: true })
}

/** Deleting a folder leaves its entries alone. Folder membership lives inside
 *  each entry's ciphertext, so the server cannot reassign it — the client
 *  treats an unresolvable folder as "unfiled". See vault/decisions/0002. */
export async function deleteFolder(app: App, userId: string, id: string): Promise<LambdaResponse> {
  if (!isValidId(id)) throw badRequest('Invalid identifier.')
  await app.store.delete(userPk(userId), folderSk(id))
  return json(200, { ok: true })
}

export async function getHistory(app: App, userId: string, entryId: string): Promise<LambdaResponse> {
  if (!isValidId(entryId)) throw badRequest('Invalid identifier.')
  const items = await app.store.query(userPk(userId), historyPrefix(entryId))
  return json(200, {
    versions: items
      .map((i) => ({ at: String(i['at']), blob: String(i['blob']) }))
      .sort((a, b) => b.at.localeCompare(a.at)),
  })
}

export async function addHistory(
  app: App, userId: string, event: LambdaEvent, entryId: string,
): Promise<LambdaResponse> {
  if (!isValidId(entryId)) throw badRequest('Invalid identifier.')
  const body = parseJsonBody<{ blob?: unknown }>(event)
  const blob = requireSealed(body.blob, 'blob')

  const current = await app.store.get(userPk(userId), entrySk(entryId))
  if (!current) throw notFound()

  const at = new Date(app.now()).toISOString()
  await app.store.put({ pk: userPk(userId), sk: historySk(entryId, at), at, blob })

  // Sort keys carry the timestamp, so the oldest are simply the first in the
  // range. Trimming here keeps a runaway client from consuming the vault's
  // whole storage allowance with versions of one entry.
  const versions = await app.store.query(userPk(userId), historyPrefix(entryId))
  if (versions.length > MAX_HISTORY) {
    const surplus = versions
      .sort((a, b) => a.sk.localeCompare(b.sk))
      .slice(0, versions.length - MAX_HISTORY)
    for (const v of surplus) await app.store.delete(v.pk, v.sk)
  }
  return json(201, { at })
}

export async function getActivity(app: App, userId: string): Promise<LambdaResponse> {
  const items = await app.store.query(userPk(userId), 'ACT#')
  return json(200, {
    events: items
      .map((i) => ({ kind: String(i['kind']), at: String(i['at']), ip: String(i['ip'] ?? '') }))
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 100),
  })
}

export const HISTORY_SK_PREFIX = HISTORY_PREFIX

/** Per-request limits for bulk import. A thousand-entry import is ten
 *  requests rather than a thousand, which keeps it inside the per-user rate
 *  limit without loosening that limit for everything else. */
export const IMPORT_MAX_ENTRIES = 100
export const IMPORT_MAX_FOLDERS = 50

/** Creates many entries and folders in one request, for import. Never
 *  overwrites: every id must be new, so a replayed or malicious import cannot
 *  replace existing items. Items are written one by one; if one fails the
 *  ones before it stay, and the response says how far it got. */
export async function bulkImport(app: App, userId: string, event: LambdaEvent): Promise<LambdaResponse> {
  const body = parseJsonBody<{ entries?: unknown; folders?: unknown }>(event)
  const entries = Array.isArray(body.entries) ? body.entries : []
  const folders = Array.isArray(body.folders) ? body.folders : []
  if (entries.length > IMPORT_MAX_ENTRIES || folders.length > IMPORT_MAX_FOLDERS) {
    throw badRequest(`At most ${IMPORT_MAX_ENTRIES} entries and ${IMPORT_MAX_FOLDERS} folders per request.`)
  }
  const parse = (list: unknown[], what: string) => list.map((raw, i) => {
    const item = raw as { id?: unknown; blob?: unknown }
    if (!isValidId(item?.id)) throw badRequest(`${what}[${i}].id is not a valid identifier.`)
    return { id: item.id, blob: requireSealed(item.blob, `${what}[${i}].blob`) }
  })
  const fs = parse(folders, 'folders')
  const es = parse(entries, 'entries')
  const at = new Date(app.now()).toISOString()
  let created = 0
  try {
    // Folders first, so entries never point at a folder that is not there yet.
    for (const f of fs) {
      await app.store.put({ pk: userPk(userId), sk: folderSk(f.id), id: f.id, blob: f.blob, createdAt: at, updatedAt: at }, { mustNotExist: true })
      created++
    }
    for (const e of es) {
      await app.store.put({ pk: userPk(userId), sk: entrySk(e.id), id: e.id, blob: e.blob, createdAt: at, updatedAt: at }, { mustNotExist: true })
      created++
    }
  } catch (err) {
    if (err instanceof AlreadyExists) throw conflict(`An item with that id already exists; ${created} item(s) were created before it.`)
    throw err
  }
  return json(201, { folders: fs.length, entries: es.length })
}
