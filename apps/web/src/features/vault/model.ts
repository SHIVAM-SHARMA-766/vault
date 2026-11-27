// The vault's data, decrypted in memory: entries, folders, and the operations
// on them. Everything is encrypted here before it leaves and decrypted here
// after it arrives; the server sees ids and ciphertext.

import { useCallback, useEffect, useState } from 'react'

import {
  type EntryContent,
  type EntryType,
  type FolderContent,
  Keyring,
  type OpenVault,
  type VaultContent,
  createVault as newVault,
  isWithinSizeLimit,
  openVaults,
  sealVault,
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
  /** Which of the account's vaults holds it; absent for Personal. */
  vaultId?: string
}

/** The vault every account has: its own vault key, no id. */
export const PERSONAL = 'Personal'

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
  const { id: _id, updatedAt: _u, unreadable: _r, vaultId: _v, ...content } = e as Decrypted & { collectionId?: unknown }
  return content
}

/** Whether an edit changed anything worth keeping a version of. Starring an
 *  entry or moving it between folders is not. */
function meaningfullyChanged(before: EntryContent, after: EntryContent): boolean {
  const strip = ({ favorite: _f, folderId: _d, passwordChangedAt: _p, ...rest }: EntryContent) => JSON.stringify(rest)
  return strip(before) !== strip(after)
}

export function useVault(vaultKey: Uint8Array) {
  const [entries, setEntries] = useState<Decrypted[]>([])
  const [folders, setFolders] = useState<Folder[]>([])
  const [vaults, setVaults] = useState<OpenVault[]>([])
  const [ring, setRing] = useState(() => new Keyring(vaultKey))
  // Each vault's wrapped key exactly as stored: a rename sends it back
  // unchanged (wrapping again would give different bytes for the same key).
  const [wrapped, setWrapped] = useState<Map<string, string>>(new Map())
  const [travel, setTravel] = useState<{ on: boolean; safe: string[] }>({ on: false, safe: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setError('')
    try {
      const { entries: sealed, folders: sealedFolders, vaults: sealedVaults = [], travel: travelNow } = await api.vault(await session.token())
      setTravel(travelNow ?? { on: false, safe: [] })
      // One request returns the whole vault; everything after this is local.
      // The server cannot search or sort it, because it cannot read it.
      const openedVaults = (await openVaults(sealedVaults, vaultKey)).sort((a, b) => a.name.localeCompare(b.name))
      const keys = new Keyring(vaultKey, openedVaults)
      const opened = await Promise.all(sealed.map(async (e): Promise<Decrypted> => {
        const where = e.vaultId ? { vaultId: e.vaultId } : {}
        try {
          const key = keys.keyFor(e.vaultId)
          if (!key) throw new Error('no key')
          return { ...(await openEntry(e.id, e.blob, key)), id: e.id, updatedAt: e.updatedAt, ...where }
        } catch {
          // One unreadable entry must not hide the rest.
          return { ...emptyEntry(), name: 'Could not decrypt', id: e.id, updatedAt: e.updatedAt, unreadable: true, ...where }
        }
      }))
      const openedFolders = (await Promise.all(sealedFolders.map(async (f) => {
        try { return { ...(await openFolder(f.id, f.blob, vaultKey)), id: f.id } } catch { return null }
      }))).filter((f): f is Folder => f !== null)
      opened.sort((a, b) => a.name.localeCompare(b.name))
      setEntries(opened)
      setFolders(openedFolders)
      setVaults(openedVaults)
      setRing(keys)
      setWrapped(new Map(sealedVaults.map((v) => [v.id, v.key])))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the vault.')
    } finally {
      setLoading(false)
    }
  }, [vaultKey])

  useEffect(() => { void load() }, [load])

  /** Saves an entry. When an existing entry changes, its previous version is
   *  sealed into its history first, so nothing typed over is lost. */
  async function saveEntry(input: EntryContent, id?: string, opts: { reload?: boolean; vaultId?: string | undefined } = {}): Promise<string> {
    const entryId = id ?? crypto.randomUUID()
    const previous = id ? entries.find((e) => e.id === id) : undefined
    // An existing item stays in its vault (moving is its own step); a new one
    // goes where it was asked to.
    const vaultId = previous ? previous.vaultId : opts.vaultId
    const key = keyOf(vaultId)
    // Record when the password changed, for the health check's "old" finding.
    const content: EntryContent = { ...input }
    if (input.password && input.password !== (previous?.password ?? '')) content.passwordChangedAt = new Date().toISOString()
    else if (previous?.passwordChangedAt) content.passwordChangedAt = previous.passwordChangedAt
    else delete content.passwordChangedAt
    const blob = await sealEntry(entryId, content, key)
    if (!isWithinSizeLimit(blob)) throw new Error('That entry is too large to store. Shorten the notes.')
    const token = await session.token()
    if (previous && !previous.unreadable && meaningfullyChanged(stripMeta(previous), content)) {
      await api.addHistory(token, entryId, await sealHistory(entryId, stripMeta(previous), key))
    }
    await api.putEntry(token, entryId, blob, vaultId)
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
      await api.putEntry(token, entry.id, await sealEntry(entry.id, { ...rest, ...(parent ? { folderId: parent } : {}) }, keyOf(entry.vaultId)), entry.vaultId)
    }
    await api.deleteFolder(token, id)
    await load()
  }

  async function history(id: string): Promise<Version[]> {
    const { versions } = await api.history(await session.token(), id)
    const opened = await Promise.all(versions.map(async (v) => {
      try { return { at: v.at, content: await openHistory(id, v.blob, keyOf(entries.find((e) => e.id === id)?.vaultId)) } } catch { return null }
    }))
    return opened.filter((v): v is Version => v !== null)
  }

  /** The key a vault's items are sealed under. */
  function keyOf(vaultId: string | undefined): Uint8Array {
    const key = ring.keyFor(vaultId)
    if (!key) throw new Error('That vault is not open in this browser. Reload and try again.')
    return key
  }

  /** Moves an item to another vault: it and every saved version are opened
   *  with the old vault's key and sealed with the new one, then replaced in
   *  one request, so the item keeps its id, history and links. */
  async function moveEntry(id: string, to: string | undefined, opts: { reload?: boolean } = {}): Promise<void> {
    const entry = entries.find((e) => e.id === id)
    if (!entry || entry.unreadable || (entry.vaultId ?? '') === (to ?? '')) return
    const from = keyOf(entry.vaultId)
    const into = keyOf(to)
    const token = await session.token()
    const { versions } = await api.history(token, id)
    const history = await Promise.all(versions.map(async (v) => ({ at: v.at, blob: await sealHistory(id, await openHistory(id, v.blob, from), into) })))
    await api.moveEntry(token, id, { blob: await sealEntry(id, stripMeta(entry), into), vaultId: to ?? null, history })
    if (opts.reload !== false) await load()
  }

  async function createVault(content: VaultContent): Promise<string> {
    const id = crypto.randomUUID()
    const { sealed } = await newVault(id, content, vaultKey)
    await api.putVault(await session.token(), id, { key: sealed.key, blob: sealed.blob })
    await load()
    return id
  }

  async function renameVault(id: string, content: VaultContent): Promise<void> {
    const v = vaults.find((x) => x.id === id)
    if (!v) return
    const sealed = await sealVault({ ...v, ...content }, vaultKey)
    await api.putVault(await session.token(), id, { key: wrapped.get(id) ?? sealed.key, blob: sealed.blob })
    await load()
  }

  /** Deletes a vault, first moving whatever is in it to Personal. */
  async function deleteVault(id: string): Promise<void> {
    for (const e of entries.filter((x) => x.vaultId === id && !x.unreadable)) await moveEntry(e.id, undefined, { reload: false })
    await api.deleteVault(await session.token(), id)
    await load()
  }

  return { entries, folders, vaults, ring, travel, loading, error, load, saveEntry, deleteEntry, saveFolder, deleteFolder, history, moveEntry, createVault, renameVault, deleteVault }
}
