// Moving items into and out of the vault. Everything happens in this browser:
// a file is read here, its items are encrypted here, and only sealed blobs go
// to the server, in batches (POST /api/vault/import). Exports are built here
// from the decrypted vault and handed to the browser as a download.

import {
  type EntryContent,
  type FolderContent,
  deriveLoginKeys,
  fromBase64Url,
  isExportFile,
  isWithinSizeLimit,
  openExport,
  sealEntry,
  sealExport,
  sealFolder,
  unwrapVaultKey,
  wipe,
} from '@vault/crypto'
import { MAX_FOLDER_DEPTH, type ImportedItem, duplicateKey, folderPath, readImport, toCsv } from '@vault/core'

import { api } from '../../lib/api.js'
import * as session from '../../lib/session.js'
import type { Decrypted, Folder } from '../vault/model.js'

/** Files larger than this are not password exports. */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024
/** The API's per-request limits (services/api/src/routes/vault.ts), and a
 *  byte budget that stays under the server's 4 MB body limit. */
const BATCH_ENTRIES = 100
const BATCH_FOLDERS = 50
const BATCH_BYTES = 3 * 1024 * 1024

/** What our encrypted export holds once opened. */
export interface ExportPayload {
  kind: 'vault-items'
  exportedAt: string
  folders: Folder[]
  entries: EntryContent[]
}

/** One item ready to import: its content and the folder path it belongs in. */
export interface Candidate { content: EntryContent; folder: string }

export interface Source {
  format: string
  candidates: Candidate[]
  warnings: string[]
}

export function fromImported(items: ImportedItem[]): Candidate[] {
  return items.map((it) => ({
    folder: it.folder,
    content: {
      name: it.name,
      type: it.type,
      ...(it.username ? { username: it.username } : {}),
      ...(it.password ? { password: it.password } : {}),
      ...(it.url ? { url: it.url } : {}),
      ...(it.notes ? { notes: it.notes } : {}),
      ...(it.totpSecret ? { totpSecret: it.totpSecret } : {}),
      ...(it.fields ? { fields: it.fields } : {}),
      tags: it.tags,
      customFields: it.customFields,
      favorite: it.favorite,
    },
  }))
}

/** Reads a picked file. Our own encrypted export needs its password; the
 *  caller asks for it when `needsPassword` comes back. */
export function readSource(text: string): Source | { needsPassword: true } {
  if (isExportFile(text)) return { needsPassword: true }
  const r = readImport(text)
  return { format: r.format, candidates: fromImported(r.items), warnings: r.warnings }
}

export async function openOwnExport(text: string, password: string): Promise<Source> {
  const payload = await openExport<ExportPayload>(password, text)
  if (payload?.kind !== 'vault-items' || !Array.isArray(payload.entries)) throw new Error('This export does not hold Vault items.')
  const folders = Array.isArray(payload.folders) ? payload.folders : []
  return {
    format: 'Vault (encrypted export)',
    candidates: payload.entries.map(({ folderId, ...content }) => ({ content, folder: folderPath(folders, folderId) })),
    warnings: [],
  }
}

export interface Plan {
  folders: { id: string; content: FolderContent; path: string }[]
  entries: EntryContent[]
  duplicates: number
}

/** Decides what will be created: which folders are new (existing ones with
 *  the same path are reused), and which items are skipped as duplicates. */
export function plan(source: Candidate[], existing: { entries: Decrypted[]; folders: Folder[] }, opts: { skipDuplicates: boolean; intoFolder?: string }): Plan {
  const seen = new Set(existing.entries.map((e) => duplicateKey(e)))
  const byPath = new Map<string, string>()
  for (const f of existing.folders) byPath.set(folderPath(existing.folders, f.id).toLowerCase(), f.id)
  const created: Plan['folders'] = []

  const resolve = (path: string): string | undefined => {
    let parts = [opts.intoFolder ?? '', ...path.split(' / ')].map((p) => p.trim()).filter(Boolean)
    if (!parts.length) return undefined
    // Deeper than the vault allows: fold the rest into the last level.
    if (parts.length > MAX_FOLDER_DEPTH) parts = [...parts.slice(0, MAX_FOLDER_DEPTH - 1), parts.slice(MAX_FOLDER_DEPTH - 1).join(' - ')]
    let parentId: string | undefined
    for (let i = 0; i < parts.length; i++) {
      const key = parts.slice(0, i + 1).join(' / ').toLowerCase()
      let id = byPath.get(key)
      if (!id) {
        id = crypto.randomUUID()
        byPath.set(key, id)
        created.push({ id, path: parts.slice(0, i + 1).join(' / '), content: { name: parts[i]!, ...(parentId ? { parentId } : {}) } })
      }
      parentId = id
    }
    return parentId
  }

  let duplicates = 0
  const entries: EntryContent[] = []
  for (const c of source) {
    const key = duplicateKey(c.content)
    if (opts.skipDuplicates && seen.has(key)) { duplicates++; continue }
    seen.add(key)
    const folderId = resolve(c.folder)
    entries.push({ ...c.content, ...(folderId ? { folderId } : {}) })
  }
  return { folders: created, entries, duplicates }
}

/** Encrypts and uploads a plan in batches. Returns how many entries were
 *  created and the names of any too large to store. */
export async function runImport(p: Plan, vaultKey: Uint8Array, onProgress: (done: number, total: number) => void): Promise<{ created: number; tooLarge: string[] }> {
  const folders = await Promise.all(p.folders.map(async (f) => ({ id: f.id, blob: await sealFolder(f.id, f.content, vaultKey) })))
  const tooLarge: string[] = []
  const sealed: { id: string; blob: string }[] = []
  for (const content of p.entries) {
    const id = crypto.randomUUID()
    const blob = await sealEntry(id, content, vaultKey)
    if (isWithinSizeLimit(blob)) sealed.push({ id, blob })
    else tooLarge.push(content.name)
  }

  const total = sealed.length
  onProgress(0, total)
  for (let i = 0; i < folders.length; i += BATCH_FOLDERS) {
    await api.importBulk(await session.token(), { folders: folders.slice(i, i + BATCH_FOLDERS), entries: [] })
  }
  let done = 0
  let batch: typeof sealed = []
  let bytes = 0
  const flush = async () => {
    if (!batch.length) return
    await api.importBulk(await session.token(), { folders: [], entries: batch })
    done += batch.length
    onProgress(done, total)
    batch = []; bytes = 0
  }
  for (const e of sealed) {
    if (batch.length >= BATCH_ENTRIES || bytes + e.blob.length > BATCH_BYTES) await flush()
    batch.push(e); bytes += e.blob.length
  }
  await flush()
  return { created: done, tooLarge }
}

/** Confirms the master password locally: the key it derives must open the
 *  account's wrapped vault key. Nothing is sent. */
export async function checkMasterPassword(state: session.Unlocked, password: string): Promise<boolean> {
  const me = await api.me(await session.token())
  const keys = await deriveLoginKeys(password, fromBase64Url(state.kdf.salt), state.kdf.iterations)
  try {
    wipe(await unwrapVaultKey(me.wrappedVaultKey, keys.kek, 'master'))
    return true
  } catch {
    return false
  } finally {
    wipe(keys.kek)
  }
}

const readable = (entries: Decrypted[]) => entries.filter((e) => !e.unreadable)

export async function encryptedExport(entries: Decrypted[], folders: Folder[], password: string): Promise<string> {
  const payload: ExportPayload = {
    kind: 'vault-items',
    exportedAt: new Date().toISOString(),
    folders,
    entries: readable(entries).map(({ id: _i, updatedAt: _u, unreadable: _r, ...content }) => content),
  }
  return sealExport(password, payload)
}

export function csvExport(entries: Decrypted[], folders: Folder[]): string {
  return toCsv(readable(entries).map((e) => ({ ...e, folder: folderPath(folders, e.folderId) })))
}

export function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  // Give the browser a moment to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const today = () => new Date().toISOString().slice(0, 10)
