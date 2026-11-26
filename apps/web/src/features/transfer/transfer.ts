// Moving items into and out of the vault. Everything happens in this browser:
// a file is read here, its items are encrypted here, and only sealed blobs go
// to the server, in batches (POST /api/vault/import). Exports are built here
// from the decrypted vault and handed to the browser as a download.

import {
  type EntryContent,
  type FolderContent,
  type KdfParams,
  fromBase64Url,
  isExportFile,
  kdfProblem,
  isWithinSizeLimit,
  openEntry,
  openExport,
  openFolder,
  sealEntry,
  sealExport,
  sealFolder,
  unlock,
  unlockWithRecoveryKey,
  unwrapVaultKey,
  wipe,
} from '@vault/crypto'
import { MAX_FOLDER_DEPTH, type ImportedItem, duplicateKey, folderPath, readImport, toCsv } from '@vault/core'

import { ApiError, api } from '../../lib/api.js'
import * as session from '../../lib/session.js'
import { deriveForAccount, loadSecretKey } from '../../lib/secretkey.js'
import type { Decrypted, Folder } from '../vault/model.js'
import { when } from '../../lib/format.js'

/** Files larger than this are not password exports. */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024
/** A personal backup carries every item's ciphertext, so it may be larger. */
export const MAX_BACKUP_BYTES = 25 * 1024 * 1024
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
  /** Encrypted attachment files a personal backup carries (D2). */
  attachments?: { id: string; blob: string }[]
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

/** Reads a picked file. Our own encrypted export needs its password, and a
 *  personal backup the master password (or recovery key) it was made under;
 *  the caller asks when `needsPassword` comes back. */
export function readSource(text: string): Source | { needsPassword: 'export' | 'backup' } {
  if (isPersonalBackup(text)) return { needsPassword: 'backup' }
  if (isExportFile(text)) return { needsPassword: 'export' }
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

// ── Personal backups (decisions/0017) ─────────────────────────────────────

/** The server writes the format first, so a glance at the start suffices. */
export const isPersonalBackup = (text: string) => /^\s*\{\s*"format"\s*:\s*"vault-personal-backup"/.test(text.slice(0, 200))

export interface OpenedBackup {
  createdAt: string
  entries: (EntryContent & { id: string })[]
  folders: Folder[]
  /** Items whose ciphertext did not open (damaged, or from another key). */
  failed: number
  attachments: { id: string; blob: string }[]
}

/** Opens a personal backup in this browser with the master password — or the
 *  recovery key — that was current when it was made. Nothing is sent
 *  anywhere. Throws UnsealError when the secret is wrong. */
export async function openPersonalBackup(text: string, secret: string, how: 'password' | 'recovery', email?: string): Promise<OpenedBackup> {
  let file: { format?: string; version?: number; createdAt?: string; kdf?: KdfParams; wrappedVaultKey?: string; recovery?: { wrappedVaultKey: string } | null; entries?: { id: string; blob: string }[]; folders?: { id: string; blob: string }[]; attachments?: { id: string; blob: string }[] }
  try { file = JSON.parse(text) } catch { throw new Error('This backup file is damaged: it is not valid JSON.') }
  if (file.format !== 'vault-personal-backup' || file.version !== 1) throw new Error('This is not a Vault personal backup, or it is from a newer version.')
  let key: Uint8Array
  if (how === 'recovery') {
    if (!file.recovery?.wrappedVaultKey) throw new Error('This backup was made without a recovery key; use the master password.')
    key = await unlockWithRecoveryKey(secret, file.recovery.wrappedVaultKey)
  } else {
    if (!file.kdf || !file.wrappedVaultKey) throw new Error('This backup file is damaged: its key is missing.')
    // A file is something anyone could hand you: refuse a key-stretching
    // setting that would freeze this tab, or one too weak to be ours.
    if (file.kdf.algorithm === 'PBKDF2-HMAC-SHA256' ? !Number.isInteger(file.kdf.iterations) || file.kdf.iterations < 600_000 || file.kdf.iterations > 10_000_000 : kdfProblem(file.kdf) !== null) {
      throw new Error('This backup file uses key settings Vault does not create, so it was not opened.')
    }
    // A backup made with a secret key (decisions/0027) needs it: this
    // browser's copy, for the account signed in here.
    const kdf = file.kdf as KdfParams
    const sk = kdf.version === 2 && email ? await loadSecretKey(email) : undefined
    if (kdf.version === 2 && !sk) throw new Error('This backup was made by an account with a secret key, and this browser does not hold it. Open it with the recovery key instead.')
    try { key = (await unlock(secret, kdf, file.wrappedVaultKey, fromBase64Url(file.kdf.salt), sk ?? undefined)).vaultKey }
    finally { sk?.fill(0) }
  }
  try {
    let failed = 0
    const folders = (await Promise.all((file.folders ?? []).map(async (f) => {
      try { return { ...(await openFolder(f.id, f.blob, key)), id: f.id } } catch { failed++; return null }
    }))).filter((f): f is Folder => f !== null)
    const entries = (await Promise.all((file.entries ?? []).map(async (e) => {
      try { return { ...(await openEntry(e.id, e.blob, key)), id: e.id } } catch { failed++; return null }
    }))).filter((e): e is EntryContent & { id: string } => e !== null)
    const attachments = (file.attachments ?? []).filter((a) => typeof a?.id === 'string' && typeof a?.blob === 'string')
    return { createdAt: file.createdAt ?? '', entries, folders, failed, attachments }
  } finally {
    wipe(key)
  }
}

/** A backup's items, as import candidates in the folders they were in. */
export function backupSource(b: OpenedBackup): Source {
  return {
    format: `Vault personal backup (${when(b.createdAt)})`,
    candidates: b.entries.map(({ id: _id, folderId, ...content }) => ({ content, folder: folderPath(b.folders, folderId) })),
    warnings: b.failed ? [`${b.failed} item${b.failed === 1 ? '' : 's'} in the backup could not be opened and will be skipped.`] : [],
    attachments: b.attachments,
  }
}

export interface Plan {
  folders: { id: string; content: FolderContent; path: string }[]
  entries: EntryContent[]
  duplicates: number
  attachments?: { id: string; blob: string }[]
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
  // Attachment files from a backup go back first, under their own ids (the
  // keys are in the entries). One already here — the same account — is kept.
  const wanted = new Set(p.entries.flatMap((e) => (e.attachments ?? []).map((a) => a.id)))
  for (const a of p.attachments ?? []) {
    if (!wanted.has(a.id)) continue
    await api.attachments.put(await session.token(), a.id, a.blob).catch((err: unknown) => { if (!(err instanceof ApiError && err.status === 409)) throw err })
  }
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
  const keys = await deriveForAccount(state, password)
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
    // Attached files are not in an export (only in personal backups): the
    // references would point at files the other end does not have.
    entries: readable(entries).map(({ id: _i, updatedAt: _u, unreadable: _r, attachments: _a, ...content }) => content),
  }
  return sealExport(password, payload)
}

export function csvExport(entries: Decrypted[], folders: Folder[]): string {
  return toCsv(readable(entries).map((e) => ({ ...e, folder: folderPath(folders, e.folderId) })))
}

export { download } from '../../lib/download.js'

/** Today's date in the user's own time zone, as YYYY-MM-DD. */
export const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
