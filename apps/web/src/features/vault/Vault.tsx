// The vault: filters and folders on the left, the list in the middle, one
// entry on the right. Data and its encryption live in model.ts; fields in
// fields.tsx; the editor and detail in their own files.

import { useEffect, useMemo, useRef, useState } from 'react'

import { ISSUES, type ListSort, analyse, descendants, flattenTree, folderTree, folderPath, matches, subtitle, typeSpec } from '@vault/core'

import { Link } from '../../lib/router.js'
import { api } from '../../lib/api.js'
import { checkBreaches } from '../../lib/breach.js'
import { useInstance } from '../../lib/instance.js'
import * as session from '../../lib/session.js'
import { IconAlert, IconInbox, IconPlus, IconRows, IconSearch, IconShield, IconStar, IconTrash } from '../../ui/icons.js'
import { Monogram, TYPES, copySecret, typeInfo, useToast } from '../../ui/kit.js'
import * as prefs from '../../lib/prefs.js'
import { navigate } from '../../lib/router.js'
import { CommandPalette, type PaletteAction, ShortcutsDialog } from './CommandPalette.js'
import { Shell } from '../../ui/Shell.js'
import { EntryDetail } from './EntryDetail.js'
import { EntryForm } from './EntryForm.js'
import { FolderDialog } from './FolderDialog.js'
import { GettingStarted } from './GettingStarted.js'
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
  const [palette, setPalette] = useState(false)
  const [shortcuts, setShortcuts] = useState(false)
  // Several items picked for one action (E5); null when not selecting.
  const [picked, setPicked] = useState<Set<string> | null>(null)
  const [bulkConfirm, setBulkConfirm] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  const view = prefs.usePrefs()
  const searchRef = useRef<HTMLInputElement>(null)

  // Keyboard shortcuts (E4; the list is in CommandPalette.tsx). Single keys
  // only when nothing is being typed and no dialog is open.
  const keyState = useRef({ mode, dialog, palette, shortcuts, picked, selectedId, visible: [] as Decrypted[] })
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const k = keyState.current
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); return }
      if (typing || k.dialog || k.palette || k.shortcuts || e.ctrlKey || e.metaKey || e.altKey) {
        if (e.key === 'Escape' && !typing && !k.dialog && !k.palette && !k.shortcuts) setSelectedId(null)
        return
      }
      const step = (d: number) => {
        const list = k.visible
        if (!list.length) return
        const i = list.findIndex((x) => x.id === k.selectedId)
        const next = list[Math.max(0, Math.min(list.length - 1, i < 0 ? 0 : i + d))]!
        setSelectedId(next.id); setMode({ kind: 'view' })
        document.querySelector(`[data-row="${next.id}"]`)?.scrollIntoView({ block: 'nearest' })
      }
      switch (e.key) {
        case '/': e.preventDefault(); searchRef.current?.focus(); break
        case 'n': if (k.mode.kind !== 'edit') { e.preventDefault(); startNew() } break
        case 'j': e.preventDefault(); step(1); break
        case 'k': e.preventDefault(); step(-1); break
        case 'e': { const sel = entries.find((x) => x.id === k.selectedId); if (sel && k.mode.kind !== 'edit' && !sel.unreadable) { e.preventDefault(); setMode({ kind: 'edit', draft: withTypeDefaults(contentOf(sel)), id: sel.id }) } break }
        case 's': e.preventDefault(); setPicked((p) => (p ? null : new Set())); break
        case 'l': e.preventDefault(); session.lock(); break
        case '?': e.preventDefault(); setShortcuts(true); break
        case 'Escape':
          if (k.picked) setPicked(null)
          else if (k.mode.kind === 'edit') setMode({ kind: 'view' })
          else setSelectedId(null)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // Re-bound every render, so the handler always sees current state.
  })

  const folderIds = useMemo(() => new Set(folders.map((f) => f.id)), [folders])
  const inFolder = (e: Decrypted) => (e.folderId && folderIds.has(e.folderId) ? e.folderId : undefined)

  // Archived items stay out of every list, count and check but the Archive.
  const active = useMemo(() => entries.filter((e) => !e.archived), [entries])
  // Breach results, by password, for this unlock only (lib/breach.ts).
  const [breaches, setBreaches] = useState<Map<string, number> | null>(null)
  const [breachProgress, setBreachProgress] = useState<string | null>(null)
  const instance = useInstance()
  const health = useMemo(() => {
    const ok = active.filter((e) => !e.unreadable)
    const hit = new Set(breaches ? ok.filter((e) => e.password && (breaches.get(e.password) ?? 0) > 0).map((e) => e.id) : [])
    const exposed = new Set(ok.filter((e) => (e as SharedEntry).exposed).map((e) => e.id))
    return analyse(ok, Date.now(), hit, exposed)
  }, [active, breaches])

  async function runBreachCheck() {
    setBreachProgress('Checking…')
    try {
      const passwords = active.filter((e) => !e.unreadable && e.password && ['login', 'wifi', 'database', 'server'].includes(e.type)).map((e) => e.password!)
      setBreaches(await checkBreaches(passwords, (done, total) => setBreachProgress(`Checking… ${done} of ${total}`)))
      setBreachProgress(null)
    } catch (err) {
      setBreachProgress(null)
      toast(err instanceof Error ? err.message : 'The breach check failed.', 'error')
    }
  }

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: active.length, favorites: 0, unfiled: 0, health: health.issues.size, archive: entries.length - active.length }
    for (const e of active) {
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
      m.set(f.id, active.filter((e) => e.folderId && ids.has(e.folderId)).length)
    }
    return m
  }, [active, folders])

  const visible = useMemo(() => {
    const scope = filter.kind === 'folder' ? descendants(folders, filter.id) : null
    return entries.filter((e) => {
      if ((filter.kind === 'archive') !== Boolean(e.archived)) return false
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
    }).sort(sorter(view.listSort))
  }, [entries, folders, filter, query, folderIds, health, view.listSort])
  keyState.current = { mode, dialog, palette, shortcuts, picked, selectedId, visible }

  const selected = entries.find((e) => e.id === selectedId) ?? null

  // Large vaults: draw the first rows at once and the rest as the list is
  // scrolled, instead of putting thousands of rows in the page on unlock.
  const PAGE = 150
  const [shown, setShown] = useState(PAGE)
  const moreRef = useRef<HTMLLIElement>(null)
  useEffect(() => { setShown(PAGE) }, [filter, query])
  useEffect(() => {
    const el = moreRef.current
    if (!el) return
    const io = new IntersectionObserver((seen) => { if (seen.some((x) => x.isIntersecting)) setShown((n) => n + PAGE * 2) }, { rootMargin: '600px' })
    io.observe(el)
    return () => io.disconnect()
  }, [shown, visible.length])
  // A selected item beyond the drawn rows is still drawn.
  useEffect(() => {
    if (!selectedId) return
    const i = visible.findIndex((e) => e.id === selectedId)
    if (i >= shown) setShown(i + PAGE)
  }, [selectedId, visible])

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

  // ── Bulk actions (E5): personal items only; shared ones belong to a collection.
  const pickable = (e: Decrypted) => !sharedOf(e) && !e.unreadable
  const pickedItems = picked ? vault.entries.filter((e) => picked.has(e.id) && pickable(e)) : []
  function togglePick(id: string) {
    setPicked((p) => { const n = new Set(p ?? []); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }
  async function bulk(change: (c: EntryContent) => EntryContent, done: (n: number) => string) {
    setBulkBusy(true)
    try {
      for (const e of pickedItems) await vault.saveEntry(change(contentOf(e)), e.id, { reload: false })
      await vault.load()
      toast(done(pickedItems.length))
      setPicked(null)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not change them all.', 'error')
      await vault.load()
    } finally { setBulkBusy(false); setBulkConfirm(false) }
  }
  async function bulkDelete() {
    setBulkBusy(true)
    try {
      const token = await session.token()
      for (const e of pickedItems) await api.deleteEntry(token, e.id)
      if (selectedId && picked?.has(selectedId)) setSelectedId(null)
      toast(`${pickedItems.length} ${pickedItems.length === 1 ? 'item' : 'items'} deleted`)
      setPicked(null)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not delete them all.', 'error')
    } finally { await vault.load(); setBulkBusy(false); setBulkConfirm(false) }
  }
  const plural = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`

  // ── Command palette actions (E4).
  const go = (f: Filter) => { setFilter(f); setSelectedId(null); setMode({ kind: 'view' }) }
  const paletteActions: PaletteAction[] = [
    { id: 'new', label: 'New item', keys: 'N', run: startNew },
    { id: 'all', label: 'Go to All items', run: () => go({ kind: 'all' }) },
    { id: 'fav', label: 'Go to Favorites', run: () => go({ kind: 'favorites' }) },
    { id: 'health', label: 'Go to Password health', hint: 'weak, reused, breached, expiring', run: () => go({ kind: 'health' }) },
    { id: 'archive', label: 'Go to Archive', run: () => go({ kind: 'archive' }) },
    { id: 'select', label: 'Select several items', keys: 'S', run: () => setPicked(new Set()) },
    { id: 'sort-name', label: 'Sort by name', run: () => void prefs.save(state.vaultKey, { listSort: 'name' }) },
    { id: 'sort-updated', label: 'Sort by recently changed', run: () => void prefs.save(state.vaultKey, { listSort: 'updated' }) },
    { id: 'sort-type', label: 'Sort by type', run: () => void prefs.save(state.vaultKey, { listSort: 'type' }) },
    { id: 'density', label: view.density === 'compact' ? 'Comfortable list' : 'Compact list', run: () => void prefs.save(state.vaultKey, { density: view.density === 'compact' ? 'comfortable' : 'compact' }) },
    { id: 'settings', label: 'Open Settings', run: () => navigate('/app/settings') },
    { id: 'security', label: 'Open Settings → Security', hint: 'two-factor, devices, share links', run: () => navigate('/app/settings/security') },
    { id: 'prefs', label: 'Open Settings → Preferences', hint: 'theme, auto-lock, clipboard', run: () => navigate('/app/settings/preferences') },
    { id: 'backups', label: 'Open Settings → Backups', run: () => navigate('/app/settings/backups') },
    { id: 'transfer', label: 'Import or export', run: () => navigate('/app/import-export') },
    { id: 'orgs', label: 'Open Organizations', run: () => navigate('/app/orgs') },
    ...(state.isAdmin ? [{ id: 'admin', label: 'Open the admin panel', run: () => navigate('/app/admin') }] : []),
    { id: 'theme', label: 'Switch to dark or light theme', run: () => { const t = view.theme === 'dark' ? 'light' : 'dark'; void prefs.save(state.vaultKey, { theme: t }) } },
    { id: 'keys', label: 'Keyboard shortcuts', keys: '?', run: () => setShortcuts(true) },
    { id: 'lock', label: 'Lock the vault', keys: 'L', run: () => session.lock() },
  ]

  function startNew() {
    const type = (filter.kind === 'type' ? filter.type : 'login') as EntryType
    setSelectedId(null)
    const collectionId = filter.kind === 'collection' && canEdit(openCollections.find((c) => c.id === filter.id)?.permission) ? filter.id : undefined
    // The open folder, else the person's default folder (F6) if it still exists.
    const fallback = folders.some((f) => f.id === view.defaultFolderId) ? view.defaultFolderId : undefined
    setMode({ kind: 'edit', draft: emptyEntry(type, filter.kind === 'folder' ? filter.id : collectionId ? undefined : fallback), ...(collectionId ? { collectionId } : {}) })
  }

  const title = filter.kind === 'all' ? 'All items' : filter.kind === 'favorites' ? 'Favorites' : filter.kind === 'archive' ? 'Archive'
    : filter.kind === 'health' ? 'Password health'
    : filter.kind === 'collection' ? (() => { const c = openCollections.find((x) => x.id === filter.id); return c ? (c.direct ? c.name : `${c.orgName} / ${c.name}`) : 'Collection' })()
    : filter.kind === 'unfiled' ? 'No folder' : filter.kind === 'type' ? typeInfo(filter.type as EntryType).plural
    : folderPath(folders, filter.id) || 'Folder'
  const paneOpen = mode.kind === 'edit' || selected !== null
  const chips: { f: Filter; label: string }[] = [
    { f: { kind: 'all' }, label: 'All' }, { f: { kind: 'favorites' }, label: 'Favorites' },
    ...folders.filter((x) => !x.parentId).map((x) => ({ f: { kind: 'folder', id: x.id } as Filter, label: x.name })),
    ...TYPES.filter((t) => entries.some((e) => e.type === t.type) || (filter.kind === 'type' && filter.type === t.type))
      .map((t) => ({ f: { kind: 'type', type: t.type } as Filter, label: t.plural })),
    { f: { kind: 'archive' }, label: 'Archive' },
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
            <div className="list-tools">
              <select aria-label="Sort by" className="select-sm" value={view.listSort} onChange={(e) => void prefs.save(state.vaultKey, { listSort: e.target.value as ListSort })}>
                <option value="name">Name</option>
                <option value="updated">Recently changed</option>
                <option value="type">Type</option>
              </select>
              <button className="icon-btn" aria-pressed={view.density === 'compact'} title={view.density === 'compact' ? 'Comfortable rows' : 'Compact rows'}
                      aria-label="Compact rows" onClick={() => void prefs.save(state.vaultKey, { density: view.density === 'compact' ? 'comfortable' : 'compact' })}>
                <IconRows size={16} />
              </button>
              <button className={`btn btn-ghost btn-sm ${picked ? 'btn-pressed' : ''}`} aria-pressed={!!picked} onClick={() => { setPicked(picked ? null : new Set()); setBulkConfirm(false) }}>
                {picked ? 'Done' : 'Select'}
              </button>
            </div>
          </div>
          {picked ? (
            <div className="bulk-bar" role="toolbar" aria-label="Selected items">
              <label className="check bulk-all">
                <input type="checkbox" aria-label="Select all shown"
                       checked={visible.filter(pickable).length > 0 && visible.filter(pickable).every((e) => picked.has(e.id))}
                       onChange={(e) => setPicked(e.target.checked ? new Set(visible.filter(pickable).map((x) => x.id)) : new Set())} />
                <span>{pickedItems.length ? `${pickedItems.length} selected` : 'Select items'}</span>
              </label>
              {bulkConfirm ? (
                <span className="bulk-actions">
                  <span className="small"><strong>Delete {plural(pickedItems.length)}?</strong> This cannot be undone.</span>
                  <button className="btn btn-secondary btn-sm" onClick={() => setBulkConfirm(false)}>Cancel</button>
                  <button className="btn btn-danger btn-sm" disabled={bulkBusy} onClick={() => void bulkDelete()}>Delete permanently</button>
                </span>
              ) : (
                <span className="bulk-actions">
                  <button className="btn btn-secondary btn-sm" disabled={!pickedItems.length || bulkBusy}
                          onClick={() => void bulk((c) => ({ ...c, favorite: !pickedItems.every((e) => e.favorite) }), (n) => pickedItems.every((e) => e.favorite) ? `${plural(n)} removed from favorites` : `${plural(n)} added to favorites`)}>
                    <IconStar size={14} />{pickedItems.length && pickedItems.every((e) => e.favorite) ? 'Unfavorite' : 'Favorite'}
                  </button>
                  <select aria-label="Move to folder" className="select-sm" disabled={!pickedItems.length || bulkBusy} value=""
                          onChange={(e) => {
                            const to = e.target.value
                            if (!to) return
                            const name = to === '-' ? 'No folder' : folderPath(folders, to)
                            void bulk((c) => { const { folderId: _f, ...rest } = c; return to === '-' ? rest : { ...rest, folderId: to } }, (n) => `${plural(n)} moved to ${name}`)
                          }}>
                    <option value="">Move to…</option>
                    <option value="-">No folder</option>
                    {flattenTree(folderTree(folders)).map((n) => <option key={n.folder.id} value={n.folder.id}>{'\u00a0\u00a0'.repeat(n.depth)}{n.folder.name}</option>)}
                  </select>
                  <button className="btn btn-secondary btn-sm" disabled={!pickedItems.length || bulkBusy}
                          onClick={() => void bulk((c) => { const { archived: _a, ...rest } = c; return filter.kind === 'archive' ? rest : { ...rest, archived: true } }, (n) => filter.kind === 'archive' ? `${plural(n)} restored` : `${plural(n)} archived`)}>
                    <IconInbox size={14} />{filter.kind === 'archive' ? 'Restore' : 'Archive'}
                  </button>
                  <button className="btn btn-danger-ghost btn-sm" disabled={!pickedItems.length || bulkBusy} onClick={() => setBulkConfirm(true)}><IconTrash size={14} />Delete</button>
                </span>
              )}
            </div>
          ) : null}
          {filter.kind === 'health' ? (
            <div className="health-summary">
              <div className={`health-score ${health.score >= 80 ? 'is-good' : health.score >= 50 ? 'is-fair' : 'is-poor'}`}>
                <strong>{health.score}</strong><span>/ 100</span>
              </div>
              <div className="health-text">
                <span className="small">{health.checked ? `${health.checked - health.failing} of ${health.checked} passwords have no issues` : 'No passwords to check yet'}</span>
                <div className="health-chips">
                  <button className={`chip ${!filter.issue ? 'chip-active' : ''}`} onClick={() => setFilter({ kind: 'health' })}>All issues</button>
                  {ISSUES.map(({ issue, label }) => (
                    <button key={issue} className={`chip ${filter.issue === issue ? 'chip-active' : ''}`} disabled={!health.counts[issue]}
                            onClick={() => setFilter({ kind: 'health', issue })}>{label} {health.counts[issue]}</button>
                  ))}
                </div>
                {instance?.breachCheck && health.checked ? (
                  <div className="breach-line">
                    {breachProgress ? <span className="small muted" role="status">{breachProgress}</span>
                      : breaches ? <span className="small" role="status">{health.counts.breached ? `${health.counts.breached} ${health.counts.breached === 1 ? 'password was' : 'passwords were'} found in known breaches.` : 'No password was found in known breaches.'}</span>
                      : <button className="btn btn-secondary btn-sm" onClick={() => void runBreachCheck()}>Check for breaches</button>}
                    <span className="hint">Only the first 5 characters of each password&apos;s SHA-1 hash are sent, through this server, to Have I Been Pwned. Your passwords never leave this browser.</span>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
          <div className="filter-chips">
            {chips.map(({ f, label }) => (
              <button key={JSON.stringify(f)} className={`chip ${sameFilter(filter, f) ? 'chip-active' : ''}`} onClick={() => setFilter(f)}>{label}</button>
            ))}
          </div>

          {vault.error ? <p className="alert alert-error"><IconAlert size={16} />{vault.error}</p> : null}
          {state.policyGap ? <p className="alert alert-warn list-alert" data-testid="server-policy-gap"><IconAlert size={16} /><span>{state.policyGap} <Link to="/app/settings/security">Open Security</Link></span></p> : null}
          {teams.orgs.filter((o) => o.policyGap).map((o) => <p key={o.id} className="alert alert-warn list-alert"><IconAlert size={16} />{o.name}: {o.policyGap}</p>)}

          {vault.loading ? (
            <div className="skeletons">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="skeleton" />)}</div>
          ) : visible.length === 0 && filter.kind === 'health' ? (
            <div className="empty"><div className="empty-icon"><IconShield size={28} /></div><h3>{health.checked ? 'No issues' : 'Nothing to check'}</h3>
              <p>{health.checked ? 'Every password here is unique, strong, recent and used over https, and nothing has expired or expires soon.' : 'Passwords of logins, Wi-Fi, databases and servers are checked once you add some; cards and documents for expiry.'}</p></div>
          ) : visible.length === 0 && filter.kind === 'archive' ? (
            <div className="empty"><div className="empty-icon"><IconInbox size={28} /></div><h3>Nothing archived</h3>
              <p>Archive an item you no longer use but want to keep: it leaves your lists, search and health check until you restore it.</p></div>
          ) : visible.length === 0 ? (
            <EmptyState hasEntries={entries.length > 0} onNew={startNew} />
          ) : (
            <ul className={`rows ${view.density === 'compact' ? 'rows-compact' : ''}`}>
              {visible.slice(0, shown).map((e) => (
                <li key={e.id} data-row={e.id} className={picked ? 'row-pickable' : ''}>
                  {picked ? (
                    <input type="checkbox" className="row-pick" aria-label={`Select ${e.name || 'Untitled'}`} disabled={!pickable(e)}
                           title={pickable(e) ? undefined : 'Shared items are changed in their collection'}
                           checked={picked.has(e.id)} onChange={() => togglePick(e.id)} />
                  ) : null}
                  <button className={`row-item ${e.id === selectedId ? 'row-active' : ''} ${picked?.has(e.id) ? 'row-picked' : ''}`}
                          onClick={() => { if (picked) { if (pickable(e)) togglePick(e.id); return } setSelectedId(e.id); setMode({ kind: 'view' }) }}>
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
              {visible.length > shown ? <li ref={moreRef} className="rows-more" aria-hidden="true" /> : null}
            </ul>
          )}
        </section>

        <section className="pane" aria-label="Details">
          {mode.kind === 'edit' ? (
            <EntryForm key={mode.id ?? 'new'} initial={mode.draft} id={mode.id} folders={folders}
                       shared={!!(mode.collectionId ?? sharedOf(entries.find((e) => e.id === mode.id)))}
                       onCancel={() => setMode({ kind: 'view' })} onSave={(c, id) => save(c, id, mode.collectionId)} />
          ) : selected ? (
            <EntryDetail key={selected.id} entry={selected} folders={folders} issues={health.issues.get(selected.id) ?? []} vaultKey={sharedOf(selected) || state.shareLinks?.allowed === false ? undefined : state.vaultKey} linkMaxDays={state.shareLinks?.maxDays ?? 30}
                         shared={(() => { const sh = sharedOf(selected); const c = sh && openCollections.find((x) => x.id === sh.collectionId); return sh && c ? {
                           where: (c.direct ? c.name : `${c.orgName} / ${c.name}`), permission: sh.permission, hidePasswords: sh.hidePasswords, sensitive: !!sh.sensitive,
                           ...(sh.permission === 'manage' ? { onSensitive: async (v: boolean) => {
                             try { await api.orgs.setSensitive(await session.token(), sh.orgId, sh.collectionId, sh.id, v); await teams.load(); toast(v ? 'Marked sensitive: admins are told when it is opened' : 'No longer sensitive') }
                             catch (err) { toast(err instanceof Error ? err.message : 'Could not change it.', 'error') }
                           } } : {}),
                         } : null })()}
                         shareTargets={sharedOf(selected) ? [] : openCollections.filter((c) => canEdit(c.permission)).map((c) => ({ id: c.id, label: (c.direct ? c.name : `${c.orgName} / ${c.name}`) }))}
                         onShare={(collectionId) => void moveToCollection(selected, collectionId)}
                         onShareWithPerson={sharedOf(selected) ? undefined : async (email) => {
                           try {
                             const r = await teams.shareWithPerson(email, contentOf(selected))
                             await vault.deleteEntry(selected.id)
                             setSelectedId(r.itemId)
                             toast(r.waiting ? `Shared. ${email} can open it after they accept and you confirm their fingerprint in Organizations.` : `Shared with ${email}`)
                           } catch (err) { toast(err instanceof Error ? err.message : 'Could not share it.', 'error') }
                         }}
                         onUnshare={() => { const sh = sharedOf(selected); if (sh) void moveToVault(sh) }}
                         onAudit={(action) => { const sh = sharedOf(selected); if (sh) void session.token().then((t) => api.orgs.report(t, sh.orgId, action, sh.collectionId, sh.id)).catch(() => {}) }}
                         onBack={() => setSelectedId(null)}
                         onEdit={() => setMode({ kind: 'edit', draft: withTypeDefaults(contentOf(selected)), id: selected.id })}
                         onToggleFavorite={() => { void save({ ...contentOf(selected), favorite: !selected.favorite }, selected.id) }}
                         onToggleArchive={sharedOf(selected) ? undefined : () => {
                           const archived = !selected.archived
                           const { archived: _a, ...rest } = contentOf(selected)
                           void save(archived ? { ...rest, archived: true } : rest, selected.id).then(() => { toast(archived ? 'Archived' : 'Restored from the archive'); setSelectedId(null) })
                         }}
                         onDelete={() => remove(selected.id)}
                         loadHistory={() => vault.history(selected.id)}
                         onRestore={async (content) => { await vault.saveEntry({ ...content, favorite: selected.favorite, ...(selected.folderId ? { folderId: selected.folderId } : {}) }, selected.id) }} />
          ) : (
            state.userId ? <GettingStarted userId={state.userId} hasItems={entries.length > 0} onNew={startNew} /> : null
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
      {palette ? (
        <CommandPalette items={entries.filter((e) => !e.archived)} actions={paletteActions}
                        onOpenItem={(id) => { go({ kind: 'all' }); setSelectedId(id) }}
                        onCopyPassword={(item) => {
                          if (!item.password) { toast('That item has no password', 'error'); return }
                          if (sharedOf(item)?.hidePasswords) { toast('Hidden by your organization’s policy', 'error'); return }
                          void copySecret(item.password).then(() => toast(`Password for ${item.name} copied`), () => toast('The browser refused clipboard access', 'error'))
                        }}
                        onClose={() => setPalette(false)} />
      ) : null}
      {shortcuts ? <ShortcutsDialog onClose={() => setShortcuts(false)} /> : null}
    </Shell>
  )
}

/** The stored content of an entry, personal or shared: without the fields
 *  this client adds to know where a shared item lives. */
/** The list's order (E6). Name is the default; updated puts the newest
 *  first; type groups items by kind, then name. */
function sorter(by: ListSort): (a: Decrypted, b: Decrypted) => number {
  const byName = (a: Decrypted, b: Decrypted) => a.name.localeCompare(b.name)
  if (by === 'updated') return (a, b) => b.updatedAt.localeCompare(a.updatedAt) || byName(a, b)
  if (by === 'type') return (a, b) => typeInfo(a.type).label.localeCompare(typeInfo(b.type).label) || byName(a, b)
  return byName
}

function contentOf(e: Decrypted): EntryContent {
  // Everything the app adds about where an item sits stays out of what is sealed.
  const { orgId: _o, collectionId: _c, permission: _p, hidePasswords: _h, exposed: _x, sensitive: _s, ...rest } = e as SharedEntry
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
