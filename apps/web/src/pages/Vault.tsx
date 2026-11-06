import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  type EntryContent,
  type EntryType,
  generateTotp,
  isWithinSizeLimit,
  openEntry,
  sealEntry,
} from '@vault/crypto'

import { api } from '../api.js'
import * as session from '../session.js'
import {
  IconAlert, IconArrowLeft, IconEdit, IconExternal, IconEye, IconEyeOff, IconGrid, IconLock,
  IconPlus, IconSearch, IconShield, IconStar, IconTrash, IconX,
} from '../icons.js'
import { CopyButton, Generator, Monogram, StrengthMeter, TYPES, typeInfo, useToast } from '../ui.js'
import { Admin } from './Admin.js'

interface Decrypted extends EntryContent {
  id: string
  updatedAt: string
  unreadable?: boolean
}

type Filter = 'all' | 'favorites' | EntryType
type Mode = { kind: 'view' } | { kind: 'edit'; draft: EntryContent; id?: string }

const empty = (type: EntryType = 'login'): EntryContent => ({
  name: '', type, username: '', password: '', url: '', notes: '',
  tags: [], customFields: [], favorite: false,
})

export function Vault({ state }: { state: session.Unlocked }) {
  const toast = useToast()
  const [entries, setEntries] = useState<Decrypted[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>({ kind: 'view' })
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const searchRef = useRef<HTMLInputElement>(null)
  const [adminOpen, setAdminOpen] = useState(() => location.pathname.startsWith('/app/admin'))

  // Learn who this is. The login response carries no user id or role, and the
  // admin panel is offered only if the server says so.
  useEffect(() => {
    void (async () => {
      try {
        const me = await api.me(await session.token())
        session.patch({ userId: me.userId, isAdmin: me.isAdmin, role: me.role, permissions: me.permissions })
      } catch { /* the vault still works; the admin entry just stays hidden */ }
    })()
  }, [])

  // /app/admin is a real address, so the back button and a reload behave.
  useEffect(() => {
    const onPop = () => setAdminOpen(location.pathname.startsWith('/app/admin'))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const openAdmin = (open: boolean) => {
    history.pushState(null, '', open ? '/app/admin' : '/app/')
    setAdminOpen(open)
  }

  const load = useCallback(async () => {
    setError('')
    try {
      const token = await session.token()
      const { entries: sealed } = await api.vault(token)

      // One request returns the whole vault; everything after this is local.
      // The server cannot search or sort it, because it cannot read it.
      const opened = await Promise.all(
        sealed.map(async (e): Promise<Decrypted> => {
          try {
            return { ...(await openEntry(e.id, e.blob, state.vaultKey)), id: e.id, updatedAt: e.updatedAt }
          } catch {
            // One unreadable entry must not hide the rest.
            return { ...empty(), name: 'Could not decrypt', id: e.id, updatedAt: e.updatedAt, unreadable: true }
          }
        }),
      )
      opened.sort((a, b) => a.name.localeCompare(b.name))
      setEntries(opened)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the vault.')
    } finally {
      setLoading(false)
    }
  }, [state.vaultKey])

  useEffect(() => { void load() }, [load])

  // "/" jumps to search, Escape backs out of whatever is open.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
      if (e.key === '/' && !typing) { e.preventDefault(); searchRef.current?.focus() }
      if (e.key === 'Escape' && !typing) {
        if (mode.kind === 'edit') setMode({ kind: 'view' })
        else setSelectedId(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode.kind])

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: entries.length, favorites: 0 }
    for (const e of entries) {
      c[e.type] = (c[e.type] ?? 0) + 1
      if (e.favorite) c['favorites']! += 1
    }
    return c
  }, [entries])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return entries.filter((e) => {
      if (filter === 'favorites' && !e.favorite) return false
      if (filter !== 'all' && filter !== 'favorites' && e.type !== filter) return false
      if (!q) return true
      return [e.name, e.username, e.url, ...e.tags].some((s) => s?.toLowerCase().includes(q))
    })
  }, [entries, filter, query])

  const selected = entries.find((e) => e.id === selectedId) ?? null

  async function save(content: EntryContent, id?: string): Promise<boolean> {
    setError('')
    try {
      const entryId = id ?? crypto.randomUUID()
      const blob = await sealEntry(entryId, content, state.vaultKey)
      if (!isWithinSizeLimit(blob)) {
        toast('That entry is too large to store. Shorten the notes.', 'error')
        return false
      }
      const token = await session.token()
      await api.putEntry(token, entryId, blob)
      await load()
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
      const token = await session.token()
      await api.deleteEntry(token, id)
      setSelectedId(null)
      setMode({ kind: 'view' })
      toast('Entry deleted')
      await load()
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not delete.', 'error')
    }
  }

  function startNew() {
    const type = filter !== 'all' && filter !== 'favorites' ? filter : 'login'
    setSelectedId(null)
    setMode({ kind: 'edit', draft: empty(type) })
  }

  if (adminOpen && state.isAdmin) return <Admin state={state} onClose={() => openAdmin(false)} />

  const filterTitle = filter === 'all' ? 'All items' : filter === 'favorites' ? 'Favorites' : typeInfo(filter).plural
  const paneOpen = mode.kind === 'edit' || selected !== null

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><span className="brand-mark"><IconShield size={18} /></span>Vault</div>
        <div className="search">
          <IconSearch size={16} />
          <input ref={searchRef} type="search" placeholder="Search vault" aria-label="Search vault"
                 value={query} onChange={(e) => setQuery(e.target.value)} />
          <kbd>/</kbd>
        </div>
        <div className="topbar-actions">
          <button className="btn btn-primary" onClick={startNew}><IconPlus size={16} /><span className="hide-sm">New item</span></button>
          {state.isAdmin ? (
            <button className="btn btn-secondary" onClick={() => openAdmin(true)} title="Admin panel">
              <IconGrid size={16} /><span className="hide-sm">Admin</span>
            </button>
          ) : null}
          <div className="account" title={state.email}>
            <span className="account-avatar">{state.email[0]?.toUpperCase()}</span>
            <span className="account-email hide-md">{state.email}</span>
          </div>
          <button className="btn btn-ghost" onClick={session.lock} title="Lock vault">
            <IconLock size={16} /><span className="hide-sm">Lock</span>
          </button>
        </div>
      </header>

      <div className={`layout ${paneOpen ? 'pane-open' : ''}`}>
        <nav className="sidebar" aria-label="Filter">
          <SideItem active={filter === 'all'} onClick={() => setFilter('all')} icon={<IconGrid size={16} />}
                    label="All items" count={counts['all']} />
          <SideItem active={filter === 'favorites'} onClick={() => setFilter('favorites')}
                    icon={<IconStar size={16} />} label="Favorites" count={counts['favorites']} />
          <div className="sidebar-heading">Types</div>
          {TYPES.map(({ type, plural, Icon }) => (
            <SideItem key={type} active={filter === type} onClick={() => setFilter(type)}
                      icon={<Icon size={16} />} label={plural} count={counts[type]} />
          ))}
          <div className="sidebar-foot">
            <IconLock size={14} /> End-to-end encrypted. Locks after 15 minutes idle.
          </div>
        </nav>

        <section className="list" aria-label={filterTitle}>
          <div className="list-head">
            <h2>{filterTitle}</h2>
            <span className="muted">{visible.length}</span>
          </div>
          <div className="filter-chips">
            {(['all', 'favorites', ...TYPES.map((t) => t.type)] as Filter[]).map((f) => (
              <button key={f} className={`chip ${filter === f ? 'chip-active' : ''}`} onClick={() => setFilter(f)}>
                {f === 'all' ? 'All' : f === 'favorites' ? 'Favorites' : typeInfo(f).plural}
              </button>
            ))}
          </div>

          {error ? <p className="alert alert-error"><IconAlert size={16} />{error}</p> : null}

          {loading ? (
            <div className="skeletons">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="skeleton" />)}</div>
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
                      <span className="row-meta">{e.unreadable ? 'This entry could not be decrypted' : e.username || hostOf(e.url) || typeInfo(e.type).label}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="pane" aria-label="Details">
          {mode.kind === 'edit' ? (
            <EntryForm key={mode.id ?? 'new'} initial={mode.draft} id={mode.id}
                       onCancel={() => setMode({ kind: 'view' })} onSave={save} />
          ) : selected ? (
            <EntryDetail key={selected.id} entry={selected}
                         onBack={() => setSelectedId(null)}
                         onEdit={() => setMode({ kind: 'edit', draft: stripMeta(selected), id: selected.id })}
                         onToggleFavorite={() => save({ ...stripMeta(selected), favorite: !selected.favorite }, selected.id)}
                         onDelete={() => remove(selected.id)} />
          ) : (
            <div className="pane-empty">
              <IconShield size={40} />
              <p>Select an item to see its details</p>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function stripMeta(e: Decrypted): EntryContent {
  const { id: _id, updatedAt: _u, unreadable: _r, ...content } = e
  return content
}

function hostOf(url: string | undefined): string {
  if (!url) return ''
  try { return new URL(url.includes('://') ? url : `https://${url}`).hostname } catch { return url }
}

function SideItem({ active, onClick, icon, label, count }: {
  active: boolean; onClick: () => void; icon: React.ReactNode; label: string; count: number | undefined
}) {
  return (
    <button className={`side-item ${active ? 'side-active' : ''}`} onClick={onClick} aria-current={active}>
      {icon}<span>{label}</span>{count ? <span className="side-count">{count}</span> : null}
    </button>
  )
}

function EmptyState({ hasEntries, onNew }: { hasEntries: boolean; onNew: () => void }) {
  return (
    <div className="empty">
      <div className="empty-icon"><IconShield size={28} /></div>
      {hasEntries ? (
        <><h3>No matches</h3><p>Nothing in this view matches your search.</p></>
      ) : (
        <>
          <h3>Your vault is empty</h3>
          <p>Add your first login. It is encrypted on this device before it is saved.</p>
          <button className="btn btn-primary" onClick={onNew}><IconPlus size={16} />Add an item</button>
        </>
      )}
    </div>
  )
}

// ── Detail ────────────────────────────────────────────────────────────────

function EntryDetail({ entry, onBack, onEdit, onToggleFavorite, onDelete }: {
  entry: Decrypted; onBack: () => void; onEdit: () => void; onToggleFavorite: () => void; onDelete: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const info = typeInfo(entry.type)
  const href = entry.url ? (entry.url.includes('://') ? entry.url : `https://${entry.url}`) : ''
  const safeHref = /^https?:\/\//i.test(href) ? href : ''

  return (
    <article className="detail">
      <div className="detail-bar">
        <button className="btn btn-ghost back-sm" onClick={onBack}><IconArrowLeft size={16} />Back</button>
        <div className="detail-actions">
          <button className={`icon-btn ${entry.favorite ? 'is-fav' : ''}`} onClick={onToggleFavorite} disabled={entry.unreadable}
                  title={entry.favorite ? 'Remove from favorites' : 'Add to favorites'} aria-label="Toggle favorite">
            <IconStar size={16} filled={entry.favorite} />
          </button>
          <button className="btn btn-secondary btn-sm" onClick={onEdit} disabled={entry.unreadable}><IconEdit size={15} />Edit</button>
          <button className="btn btn-danger-ghost btn-sm" onClick={() => setConfirming(true)}><IconTrash size={15} />Delete</button>
        </div>
      </div>

      <header className="detail-head">
        <Monogram name={entry.name} size="lg" />
        <div>
          <h2>{entry.name || 'Untitled'}</h2>
          <span className="badge"><info.Icon size={13} />{info.label}</span>
        </div>
      </header>

      {confirming ? (
        <div className="confirm">
          <p><strong>Delete “{entry.name || 'Untitled'}”?</strong> This cannot be undone.</p>
          <div className="confirm-actions">
            <button className="btn btn-secondary btn-sm" onClick={() => setConfirming(false)}>Cancel</button>
            <button className="btn btn-danger btn-sm" onClick={onDelete}>Delete permanently</button>
          </div>
        </div>
      ) : null}

      <div className="fields">
        <FieldRow label="Username" value={entry.username} copy />
        <SecretRow label="Password" value={entry.password} showStrength />
        {entry.totpSecret ? <TotpRow secret={entry.totpSecret} /> : null}
        {entry.url ? (
          <div className="field-row">
            <span className="field-label">Website</span>
            <div className="field-value">
              <span className="truncate">{entry.url}</span>
              <span className="field-tools">
                {safeHref ? (
                  <a className="icon-btn" href={safeHref} target="_blank" rel="noopener noreferrer" title="Open website" aria-label="Open website">
                    <IconExternal size={16} />
                  </a>
                ) : null}
                <CopyButton value={entry.url} label="Website" />
              </span>
            </div>
          </div>
        ) : null}
        {entry.customFields.map((f, i) =>
          f.hidden ? <SecretRow key={i} label={f.label} value={f.value} />
                   : <FieldRow key={i} label={f.label} value={f.value} copy />)}
      </div>

      {entry.notes ? (
        <div className="notes">
          <span className="field-label">Notes</span>
          <pre>{entry.notes}</pre>
        </div>
      ) : null}

      {entry.tags.length ? (
        <div className="tags">{entry.tags.map((t) => <span key={t} className="tag">{t}</span>)}</div>
      ) : null}

      <p className="detail-foot">Last modified {formatDate(entry.updatedAt)}</p>
    </article>
  )
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function FieldRow({ label, value, copy }: { label: string; value: string | undefined; copy?: boolean }) {
  if (!value) return null
  return (
    <div className="field-row">
      <span className="field-label">{label}</span>
      <div className="field-value">
        <span className="truncate">{value}</span>
        {copy ? <span className="field-tools"><CopyButton value={value} label={label} /></span> : null}
      </div>
    </div>
  )
}

function SecretRow({ label, value, showStrength }: { label: string; value: string | undefined; showStrength?: boolean }) {
  const [revealed, setRevealed] = useState(false)
  if (!value) return null
  return (
    <div className="field-row">
      <span className="field-label">{label}</span>
      <div className="field-value">
        <span className="mono truncate">{revealed ? value : '•'.repeat(Math.min(value.length, 16))}</span>
        <span className="field-tools">
          <button type="button" className="icon-btn" onClick={() => setRevealed(!revealed)}
                  title={revealed ? 'Hide' : 'Reveal'} aria-label={revealed ? `Hide ${label}` : `Reveal ${label}`}>
            {revealed ? <IconEyeOff size={16} /> : <IconEye size={16} />}
          </button>
          <CopyButton value={value} label={label} />
        </span>
      </div>
      {showStrength ? <StrengthMeter password={value} /> : null}
    </div>
  )
}

function TotpRow({ secret }: { secret: string }) {
  const [code, setCode] = useState<{ code: string; secondsRemaining: number } | null>(null)
  const [bad, setBad] = useState(false)

  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const next = await generateTotp(secret.replace(/\s+/g, ''))
        if (alive) setCode(next)
      } catch {
        if (alive) setBad(true)
      }
    }
    void tick()
    const t = setInterval(tick, 1000)
    return () => { alive = false; clearInterval(t) }
  }, [secret])

  return (
    <div className="field-row">
      <span className="field-label">One-time code</span>
      <div className="field-value">
        {bad ? <span className="muted">The stored secret is not valid Base32</span> : code ? (
          <>
            <span className="mono totp">{code.code.slice(0, 3)} {code.code.slice(3)}</span>
            <span className="field-tools">
              <span className={`totp-timer ${code.secondsRemaining <= 5 ? 'totp-low' : ''}`}>{code.secondsRemaining}s</span>
              <CopyButton value={code.code} label="Code" />
            </span>
          </>
        ) : <span className="muted">…</span>}
      </div>
    </div>
  )
}

// ── Editor ────────────────────────────────────────────────────────────────

function EntryForm({ initial, id, onCancel, onSave }: {
  initial: EntryContent
  id?: string | undefined
  onCancel: () => void
  onSave: (content: EntryContent, id?: string) => Promise<boolean>
}) {
  const [draft, setDraft] = useState<EntryContent>(initial)
  const [showGen, setShowGen] = useState(false)
  const [showPw, setShowPw] = useState(false)
  const [saving, setSaving] = useState(false)
  const [tagText, setTagText] = useState(initial.tags.join(', '))

  const set = <K extends keyof EntryContent>(k: K, v: EntryContent[K]) => setDraft((d) => ({ ...d, [k]: v }))
  const isNote = draft.type === 'note'

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    const tags = tagText.split(',').map((t) => t.trim()).filter(Boolean)
    const ok = await onSave({ ...draft, tags: [...new Set(tags)] }, id)
    if (!ok) setSaving(false)
  }

  return (
    <form className="editor" onSubmit={submit}>
      <div className="detail-bar">
        <h2>{id ? 'Edit item' : 'New item'}</h2>
        <button type="button" className="icon-btn" onClick={onCancel} aria-label="Close"><IconX size={18} /></button>
      </div>

      <div className="editor-body">
        <div className="grid-2">
          <div className="field">
            <label htmlFor="f-type">Type</label>
            <select id="f-type" value={draft.type} onChange={(e) => set('type', e.target.value as EntryType)}>
              {TYPES.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-name">Name</label>
            <input id="f-name" required autoFocus placeholder="e.g. GitHub" value={draft.name}
                   onChange={(e) => set('name', e.target.value)} />
          </div>
        </div>

        {!isNote ? (
          <>
            <div className="field">
              <label htmlFor="f-username">{draft.type === 'wifi' ? 'Network name (SSID)' : 'Username or email'}</label>
              <input id="f-username" autoComplete="off" spellCheck={false} value={draft.username ?? ''}
                     onChange={(e) => set('username', e.target.value)} />
            </div>

            <div className="field">
              <div className="label-row">
                <label htmlFor="f-password">Password</label>
                <button type="button" className="link" onClick={() => setShowGen(!showGen)}>
                  {showGen ? 'Hide generator' : 'Generate'}
                </button>
              </div>
              <div className="input-wrap">
                <input id="f-password" type={showPw ? 'text' : 'password'} autoComplete="new-password"
                       spellCheck={false} className="mono" value={draft.password ?? ''}
                       onChange={(e) => set('password', e.target.value)} />
                <button type="button" className="input-affix" onClick={() => setShowPw(!showPw)}
                        aria-label={showPw ? 'Hide password' : 'Show password'}>
                  {showPw ? <IconEyeOff size={16} /> : <IconEye size={16} />}
                </button>
              </div>
              <StrengthMeter password={draft.password ?? ''} />
              {showGen ? <Generator onUse={(p) => { set('password', p); setShowPw(true); setShowGen(false) }} /> : null}
            </div>

            {draft.type === 'login' ? (
              <div className="grid-2">
                <div className="field">
                  <label htmlFor="f-url">Website</label>
                  <input id="f-url" type="text" inputMode="url" placeholder="https://" spellCheck={false}
                         value={draft.url ?? ''} onChange={(e) => set('url', e.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="f-totp">Authenticator key (TOTP)</label>
                  <input id="f-totp" spellCheck={false} className="mono" placeholder="Base32 secret"
                         value={draft.totpSecret ?? ''} onChange={(e) => set('totpSecret', e.target.value || undefined)} />
                </div>
              </div>
            ) : null}
          </>
        ) : null}

        <div className="field">
          <label htmlFor="f-notes">Notes</label>
          <textarea id="f-notes" rows={isNote ? 10 : 4} value={draft.notes ?? ''}
                    onChange={(e) => set('notes', e.target.value)} />
        </div>

        <div className="field">
          <label htmlFor="f-tags">Tags</label>
          <input id="f-tags" placeholder="work, personal" value={tagText} onChange={(e) => setTagText(e.target.value)} />
          <p className="hint">Separate with commas. Tags are encrypted along with everything else.</p>
        </div>
      </div>

      <div className="editor-foot">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={!draft.name.trim() || saving}>
          {saving ? <><span className="spinner" />Encrypting…</> : 'Save'}
        </button>
      </div>
    </form>
  )
}
