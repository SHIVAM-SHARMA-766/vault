// The vault's data, decrypted in memory: entries, folders, and the operations
// on them. Everything is encrypted here before it leaves and decrypted here
// after it arrives; the server sees ids and ciphertext.

import { useCallback, useEffect, useState } from 'react'

import {
  type EntryContent,
  type EntryType,
  type FolderContent,
  isWithinSizeLimit,
  openEntry,
  openFolder,
  openHistory,
  sealEntry,
  sealFolder,
  sealHistory,
} from '@vault/crypto'

import { api } from '../../lib/api.js'
import * as session from '../../lib/session.js'

export interface Decrypted extends EntryContent {
  id: string
  updatedAt: string
  unreadable?: boolean
}

export interface Folder extends FolderContent {
  id: string
}

export interface Version {
  at: string
  content: EntryContent
}

export const emptyEntry = (type: EntryType = 'login', folderId?: string): EntryContent => ({
  name: '', type, username: '', password: '', url: '', notes: '',
  tags: [], customFields: [], fields: {}, favorite: false,
  ...(folderId ? { folderId } : {}),
})

export function stripMeta(e: Decrypted): EntryContent {
  const { id: _id, updatedAt: _u, unreadable: _r, ...content } = e
  return content
}

/** Whether an edit changed anything worth keeping a version of. Starring an
 *  entry or moving it between folders is not. */
function meaningfullyChanged(before: EntryContent, after: EntryContent): boolean {
  const strip = ({ favorite: _f, folderId: _d, ...rest }: EntryContent) => JSON.stringify(rest)
  return strip(before) !== strip(after)
}

export function useVault(vaultKey: Uint8Array) {
  const [entries, setEntries] = useState<Decrypted[]>([])
  const [folders, setFolders] = useState<Folder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setError('')
    try {
      const { entries: sealed, folders: sealedFolders } = await api.vault(await session.token())
      // One request returns the whole vault; everything after this is local.
      // The server cannot search or sort it, because it cannot read it.
      const opened = await Promise.all(sealed.map(async (e): Promise<Decrypted> => {
        try {
          return { ...(await openEntry(e.id, e.blob, vaultKey)), id: e.id, updatedAt: e.updatedAt }
        } catch {
          // One unreadable entry must not hide the rest.
          return { ...emptyEntry(), name: 'Could not decrypt', id: e.id, updatedAt: e.updatedAt, unreadable: true }
        }
      }))
      const openedFolders = (await Promise.all(sealedFolders.map(async (f) => {
        try { return { ...(await openFolder(f.id, f.blob, vaultKey)), id: f.id } } catch { return null }
      }))).filter((f): f is Folder => f !== null)
      opened.sort((a, b) => a.name.localeCompare(b.name))
      setEntries(opened)
      setFolders(openedFolders)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the vault.')
    } finally {
      setLoading(false)
    }
  }, [vaultKey])

  useEffect(() => { void load() }, [load])

  /** Saves an entry. When an existing entry changes, its previous version is
   *  sealed into its history first, so nothing typed over is lost. */
  async function saveEntry(content: EntryContent, id?: string, opts: { reload?: boolean } = {}): Promise<string> {
    const entryId = id ?? crypto.randomUUID()
    const blob = await sealEntry(entryId, content, vaultKey)
    if (!isWithinSizeLimit(blob)) throw new Error('That entry is too large to store. Shorten the notes.')
    const token = await session.token()
    const previous = id ? entries.find((e) => e.id === id) : undefined
    if (previous && !previous.unreadable && meaningfullyChanged(stripMeta(previous), content)) {
      await api.addHistory(token, entryId, await sealHistory(entryId, stripMeta(previous), vaultKey))
    }
    await api.putEntry(token, entryId, blob)
    if (opts.reload !== false) await load()
    return entryId
  }

  async function deleteEntry(id: string) {
    await api.deleteEntry(await session.token(), id)
    await load()
  }

  async function saveFolder(content: FolderContent, id?: string): Promise<string> {
    const folderId = id ?? crypto.randomUUID()
    await api.putFolder(await session.token(), folderId, await sealFolder(folderId, content, vaultKey))
    await load()
    return folderId
  }

  /** Deletes a folder. Its subfolders and entries move up to its parent
   *  rather than disappearing with it. */
  async function deleteFolder(id: string) {
    const folder = folders.find((f) => f.id === id)
    if (!folder) return
    const token = await session.token()
    const parent = folder.parentId
    for (const child of folders.filter((f) => f.parentId === id)) {
      const { id: childId, ...content } = child
      const moved: FolderContent = { name: content.name, ...(parent ? { parentId: parent } : {}) }
      await api.putFolder(token, childId, await sealFolder(childId, moved, vaultKey))
    }
    for (const entry of entries.filter((e) => e.folderId === id && !e.unreadable)) {
      const { folderId: _f, ...rest } = stripMeta(entry)
      await api.putEntry(token, entry.id, await sealEntry(entry.id, { ...rest, ...(parent ? { folderId: parent } : {}) }, vaultKey))
    }
    await api.deleteFolder(token, id)
    await load()
  }

  async function history(id: string): Promise<Version[]> {
    const { versions } = await api.history(await session.token(), id)
    const opened = await Promise.all(versions.map(async (v) => {
      try { return { at: v.at, content: await openHistory(id, v.blob, vaultKey) } } catch { return null }
    }))
    return opened.filter((v): v is Version => v !== null)
  }

  return { entries, folders, loading, error, load, saveEntry, deleteEntry, saveFolder, deleteFolder, history }
}
