// The vault: filters and folders on the left, the list in the middle, one
// entry on the right. Data and its encryption live in model.ts; fields in
// fields.tsx; the editor and detail in their own files.

import { useEffect, useMemo, useRef, useState } from 'react'

import { ISSUES, analyse, descendants, folderPath, matches, subtitle, typeSpec } from '@vault/core'

import { Link } from '../../lib/router.js'
import * as session from '../../lib/session.js'
import { IconAlert, IconPlus, IconSearch, IconShield, IconStar } from '../../ui/icons.js'
import { Monogram, TYPES, typeInfo, useToast } from '../../ui/kit.js'
import { Shell } from '../../ui/Shell.js'
import { EntryDetail } from './EntryDetail.js'
import { EntryForm } from './EntryForm.js'
import { FolderDialog } from './FolderDialog.js'
import { type Decrypted, type Folder, emptyEntry, stripMeta, useVault } from './model.js'
import { type SharedEntry, canEdit, useTeams } from '../orgs/model.js'
import { type Filter, Sidebar, sameFilter } from './Sidebar.js'
import type { EntryContent, EntryType } from '@vault/crypto'

type Mode = { kind: 'view' } | { kind: 'edit'; draft: EntryContent; id?: string; collectionId?: string }
type Dialog = { kind: 'new'; parentId?: string } | { kind: 'rename'; folder: Folder } | { kind: 'delete'; folder: Folder } | null

export function Vault({ state }: { state: session.Unlocked }) {
  const toast = useToast()
  const vault = useVault(state.vaultKey)
  const teams = useTeams(state.vaultKey)
  const { folders } = vault
  // Personal entries and the shared items this account can open, together.
  const entries: (Decrypted | SharedEntry)[] = useMemo(() => [...vault.entries, ...teams.shared].sort((a, b) => a.name.localeCompare(b.name)), [vault.entries, teams.shared])
  const openCollections = useMemo(() => teams.collections.filter((c) => c.key), [teams.collections])
  const sharedOf = (e: Decrypted | null | undefined): SharedEntry | null => (e && 'collectionId' in e ? (e as SharedEntry) : null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>({ kind: 'view' })
  const [filter, setFilter] = useState<Filter>({ kind: 'all' })
  const [query, setQuery] = useState('')
  const [dialog, setDialog] = useState<Dialog>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // "/" jumps to search, Escape backs out of whatever is open.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement
      if (e.key === '/' && !typing) { e.preventDefault(); searchRef.current?.focus() }
      if (e.key === 'Escape' && !typing && !dialog) {
        if (mode.kind === 'edit') setMode({ kind: 'view' })
        else setSelectedId(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode.kind, dialog])

  const folderIds = useMemo(() => new Set(folders.map((f) => f.id)), [folders])
  const inFolder = (e: Decrypted) => (e.folderId && folderIds.has(e.folderId) ? e.folderId : undefined)

  const health = useMemo(() => analyse(entries.filter((e) => !e.unreadable)), [entries])

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: entries.length, favorites: 0, unfiled: 0, health: health.issues.size }
    for (const e of entries) {
      c[e.type] = (c[e.type] ?? 0) + 1
      const sh = sharedOf(e)
      if (sh) c[`coll:${sh.collectionId}`] = (c[`coll:${sh.collectionId}`] ?? 0) + 1
      if (e.favorite) c['favorites']! += 1
      if (!inFolder(e) && !sharedOf(e)) c['unfiled']! += 1
    }
    return c
  }, [entries, folderIds, health])

  // A folder's count includes everything beneath it.
  const folderCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const f of folders) {
      const ids = descendants(folders, f.id)
      m.set(f.id, entries.filter((e) => e.folderId && ids.has(e.folderId)).length)
    }
    return m
  }, [entries, folders])

  const visible = useMemo(() => {
    const scope = filter.kind === 'folder' ? descendants(folders, filter.id) : null
    return entries.filter((e) => {
      if (filter.kind === 'favorites' && !e.favorite) return false
      if (filter.kind === 'collection' && sharedOf(e)?.collectionId !== filter.id) return false
      if (filter.kind === 'health') {
        const found = health.issues.get(e.id)
        if (!found || (filter.issue && !found.includes(filter.issue))) return false
      }
      if (filter.kind === 'type' && e.type !== filter.type) return false
      if (filter.kind === 'unfiled' && (inFolder(e) || sharedOf(e))) return false
      if (scope && !(e.folderId && scope.has(e.folderId))) return false
      return matches(e, query, folderPath(folders, inFolder(e)))
    })
  }, [entries, folders, filter, query, folderIds, health])

  const selected = entries.find((e) => e.id === selectedId) ?? null

  async function save(content: EntryContent, id?: string, collectionId?: string): Promise<boolean> {
    try {
      const target = collectionId ?? sharedOf(entries.find((e) => e.id === id))?.collectionId
      const entryId = target ? await teams.saveShared(target, content, id) : await vault.saveEntry(content, id)
      setSelectedId(entryId)
      setMode({ kind: 'view' })
      return true
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save.', 'error')
      return false
    }
  }

  async function remove(id: string) {
    try {
      const sh = sharedOf(entries.find((e) => e.id === id))
      if (sh) await teams.deleteShared(sh.collectionId, id)
      else await vault.deleteEntry(id)
      setSelectedId(null)
      setMode({ kind: 'view' })
      toast('Entry deleted')
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not delete.', 'error')
    }
  }

  /** Sharing an item moves it: re-encrypted under the collection key, then
   *  removed from the personal vault — an item lives in one place (0009). */
  async function moveToCollection(entry: Decrypted, collectionId: string) {
    try {
      const { folderId: _f, ...content } = contentOf(entry)
      const id = await teams.saveShared(collectionId, content)
      await vault.deleteEntry(entry.id)
      setSelectedId(id)
      toast(`Moved to ${openCollections.find((c) => c.id === collectionId)?.name ?? 'the collection'}`)
    } catch (err) { toast(err instanceof Error ? err.message : 'Could not move it.', 'error') }
  }

  async function moveToVault(entry: SharedEntry) {
    try {
      const id = await vault.saveEntry(contentOf(entry))
      await teams.deleteShared(entry.collectionId, entry.id)
      setSelectedId(id)
      toast('Moved to your vault')
    } catch (err) { toast(err instanceof Error ? err.message : 'Could not move it.', 'error') }
  }

  function startNew() {
    const type = (filter.kind === 'type' ? filter.type : 'login') as EntryType
    setSelectedId(null)
    const collectionId = filter.kind === 'collection' && canEdit(openCollections.find((c) => c.id === filter.id)?.permission) ? filter.id : undefined
    setMode({ kind: 'edit', draft: emptyEntry(type, filter.kind === 'folder' ? filter.id : undefined), ...(collectionId ? { collectionId } : {}) })
  }

  const title = filter.kind === 'all' ? 'All items' : filter.kind === 'favorites' ? 'Favorites'
    : filter.kind === 'health' ? 'Password health'
    : filter.kind === 'collection' ? (() => { const c = openCollections.find((x) => x.id === filter.id); return c ? `${c.orgName} / ${c.name}` : 'Collection' })()
    : filter.kind === 'unfiled' ? 'No folder' : filter.kind === 'type' ? typeInfo(filter.type as EntryType).plural
    : folderPath(folders, filter.id) || 'Folder'
  const paneOpen = mode.kind === 'edit' || selected !== null
  const chips: { f: Filter; label: string }[] = [
    { f: { kind: 'all' }, label: 'All' }, { f: { kind: 'favorites' }, label: 'Favorites' },
    ...folders.filter((x) => !x.parentId).map((x) => ({ f: { kind: 'folder', id: x.id } as Filter, label: x.name })),
    ...TYPES.map((t) => ({ f: { kind: 'type', type: t.type } as Filter, label: t.plural })),
  ]

  return (
    <Shell
      state={state}
      center={
        <div className="search">
          <IconSearch size={16} />
          <input ref={searchRef} type="search" placeholder="Search vault" aria-label="Search vault"
                 value={query} onChange={(e) => setQuery(e.target.value)} />
          <kbd>/</kbd>
        </div>
      }
      actions={<button className="btn btn-primary" onClick={startNew}><IconPlus size={16} /><span className="hide-sm">New item</span></button>}
    >
      <div className={`layout ${paneOpen ? 'pane-open' : ''}`}>
        <Sidebar filter={filter} setFilter={setFilter} counts={counts} folders={folders} folderCounts={folderCounts}
                 collections={openCollections.map((c) => ({ id: c.id, label: c.name, group: c.orgName }))}
                 onNewFolder={(parentId) => setDialog({ kind: 'new', ...(parentId ? { parentId } : {}) })}
                 onRenameFolder={(folder) => setDialog({ kind: 'rename', folder })}
                 onDeleteFolder={(folder) => setDialog({ kind: 'delete', folder })} />

        <section className="list" aria-label={title}>
          <div className="list-head">
            <h2 className="truncate">{title}</h2>
            <span className="muted">{visible.length}</span>
          </div>
          {filter.kind === 'health' ? (
            <div className="health-summary">
              <div className={`health-score ${health.score >= 80 ? 'is-good' : health.score >= 50 ? 'is-fair' : 'is-poor'}`}>
                <strong>{health.score}</strong><span>/ 100</span>
              </div>
              <div className="health-text">
                <span className="small">{health.checked ? `${health.checked - health.issues.size} of ${health.checked} passwords have no issues` : 'No passwords to check yet'}</span>
                <div className="health-chips">
                  <button className={`chip ${!filter.issue ? 'chip-active' : ''}`} onClick={() => setFilter({ kind: 'health' })}>All issues</button>
                  {ISSUES.map(({ issue, label }) => (
                    <button key={issue} className={`chip ${filter.issue === issue ? 'chip-active' : ''}`} disabled={!health.counts[issue]}
                            onClick={() => setFilter({ kind: 'health', issue })}>{label} {health.counts[issue]}</button>
                  ))}
                </div>
              </div>
            </div>
          ) : null}
          <div className="filter-chips">
            {chips.map(({ f, label }) => (
              <button key={JSON.stringify(f)} className={`chip ${sameFilter(filter, f) ? 'chip-active' : ''}`} onClick={() => setFilter(f)}>{label}</button>
            ))}
          </div>

          {vault.error ? <p className="alert alert-error"><IconAlert size={16} />{vault.error}</p> : null}
          {teams.orgs.filter((o) => o.policyGap).map((o) => <p key={o.id} className="alert alert-warn list-alert"><IconAlert size={16} />{o.name}: {o.policyGap}</p>)}

          {vault.loading ? (
            <div className="skeletons">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="skeleton" />)}</div>
          ) : visible.length === 0 && filter.kind === 'health' ? (
            <div className="empty"><div className="empty-icon"><IconShield size={28} /></div><h3>{health.checked ? 'No issues' : 'Nothing to check'}</h3>
              <p>{health.checked ? 'Every password here is unique, strong, recent and used over https.' : 'Logins and Wi-Fi passwords are checked once you add some.'}</p></div>
          ) : visible.length === 0 ? (
            <EmptyState hasEntries={entries.length > 0} onNew={startNew} />
          ) : (
            <ul className="rows">
              {visible.map((e) => (
                <li key={e.id}>
                  <button className={`row-item ${e.id === selectedId ? 'row-active' : ''}`}
                          onClick={() => { setSelectedId(e.id); setMode({ kind: 'view' }) }}>
                    <Monogram name={e.name} />
                    <span className="row-text">
                      <span className="row-name">{e.name || 'Untitled'}{e.favorite ? <span className="row-star"><IconStar size={12} filled /></span> : null}</span>
                      <span className="row-meta">{e.unreadable ? 'This entry could not be decrypted' : filter.kind === 'health'
                        ? (health.issues.get(e.id) ?? []).map((i) => ISSUES.find((x) => x.issue === i)!.label).join(' · ')
                        : subtitle(e)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="pane" aria-label="Details">
          {mode.kind === 'edit' ? (
            <EntryForm key={mode.id ?? 'new'} initial={mode.draft} id={mode.id} folders={folders}
                       shared={!!(mode.collectionId ?? sharedOf(entries.find((e) => e.id === mode.id)))}
                       onCancel={() => setMode({ kind: 'view' })} onSave={(c, id) => save(c, id, mode.collectionId)} />
          ) : selected ? (
            <EntryDetail key={selected.id} entry={selected} folders={folders} issues={health.issues.get(selected.id) ?? []}
                         shared={(() => { const sh = sharedOf(selected); const c = sh && openCollections.find((x) => x.id === sh.collectionId); return sh && c ? { where: `${c.orgName} / ${c.name}`, permission: sh.permission, hidePasswords: sh.hidePasswords } : null })()}
                         shareTargets={sharedOf(selected) ? [] : openCollections.filter((c) => canEdit(c.permission)).map((c) => ({ id: c.id, label: `${c.orgName} / ${c.name}` }))}
                         onShare={(collectionId) => void moveToCollection(selected, collectionId)}
                         onUnshare={() => { const sh = sharedOf(selected); if (sh) void moveToVault(sh) }}
                         onBack={() => setSelectedId(null)}
                         onEdit={() => setMode({ kind: 'edit', draft: withTypeDefaults(contentOf(selected)), id: selected.id })}
                         onToggleFavorite={() => { void save({ ...contentOf(selected), favorite: !selected.favorite }, selected.id) }}
                         onDelete={() => remove(selected.id)}
                         loadHistory={() => vault.history(selected.id)}
                         onRestore={async (content) => { await vault.saveEntry({ ...content, favorite: selected.favorite, ...(selected.folderId ? { folderId: selected.folderId } : {}) }, selected.id) }} />
          ) : (
            <div className="pane-empty">
              <IconShield size={40} />
              <p>Select an item to see its details</p>
            </div>
          )}
        </section>
      </div>

      {dialog?.kind === 'new' ? (
        <FolderDialog title={dialog.parentId ? 'New folder inside' : 'New folder'}
                      {...(dialog.parentId ? { parentPath: folderPath(folders, dialog.parentId) } : {})}
                      onCancel={() => setDialog(null)}
                      onSave={async (name) => {
                        const id = await vault.saveFolder({ name, ...(dialog.parentId ? { parentId: dialog.parentId } : {}) })
                        setDialog(null)
                        setFilter({ kind: 'folder', id })
                        toast('Folder created')
                      }} />
      ) : null}
      {dialog?.kind === 'rename' ? (
        <FolderDialog title="Rename folder" initial={dialog.folder.name}
                      onCancel={() => setDialog(null)}
                      onSave={async (name) => {
                        const { id, ...content } = dialog.folder
                        await vault.saveFolder({ ...content, name }, id)
                        setDialog(null)
                        toast('Folder renamed')
                      }} />
      ) : null}
      {dialog?.kind === 'delete' ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="del-folder">
          <div className="modal">
            <h2 id="del-folder">Delete “{dialog.folder.name}”?</h2>
            <p className="muted">Its items and subfolders move up to {dialog.folder.parentId ? `“${folderPath(folders, dialog.folder.parentId)}”` : 'no folder'}. Nothing inside is deleted.</p>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setDialog(null)}>Cancel</button>
              <button className="btn btn-danger" onClick={async () => {
                try {
                  await vault.deleteFolder(dialog.folder.id)
                  if (filter.kind === 'folder' && filter.id === dialog.folder.id) setFilter({ kind: 'all' })
                  setDialog(null)
                  toast('Folder deleted; its contents moved up')
                } catch (err) { toast(err instanceof Error ? err.message : 'Could not delete the folder.', 'error') }
              }}>Delete folder</button>
            </div>
          </div>
        </div>
      ) : null}
    </Shell>
  )
}

/** The stored content of an entry, personal or shared: without the fields
 *  this client adds to know where a shared item lives. */
function contentOf(e: Decrypted): EntryContent {
  const { orgId: _o, collectionId: _c, permission: _p, hidePasswords: _h, ...rest } = e as SharedEntry
  return stripMeta(rest as Decrypted)
}

/** Older entries predate type fields; give the editor an object to write into. */
function withTypeDefaults(c: EntryContent): EntryContent {
  return { ...c, fields: c.fields ?? {}, customFields: c.customFields ?? [], tags: c.tags ?? [], type: typeSpec(c.type).type as EntryType }
}

function EmptyState({ hasEntries, onNew }: { hasEntries: boolean; onNew: () => void }) {
  return (
    <div className="empty">
      <div className="empty-icon"><IconShield size={28} /></div>
      {hasEntries ? (
        <><h3>Nothing here</h3><p>No items in this view match. Try another folder or search.</p></>
      ) : (
        <>
          <h3>Your vault is empty</h3>
          <p>Add your first login. It is encrypted on this device before it is saved.</p>
          <button className="btn btn-primary" onClick={onNew}><IconPlus size={16} />Add an item</button>
          <Link to="/app/import-export" className="btn btn-ghost">Import from another password manager</Link>
        </>
      )}
    </div>
  )
}
