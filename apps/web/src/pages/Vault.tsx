import { useCallback, useEffect, useState } from 'react'

import {
  type EntryContent,
  isWithinSizeLimit,
  openEntry,
  sealEntry,
} from '@vault/crypto'

import { api } from '../api.js'
import * as session from '../session.js'

interface Decrypted extends EntryContent {
  id: string
  updatedAt: string
}

const empty = (): EntryContent => ({
  name: '', type: 'login', username: '', password: '', url: '', notes: '',
  tags: [], customFields: [], favorite: false,
})

export function Vault({ state }: { state: session.Unlocked }) {
  const [entries, setEntries] = useState<Decrypted[]>([])
  const [selected, setSelected] = useState<Decrypted | null>(null)
  const [editing, setEditing] = useState<EntryContent | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setError('')
    try {
      const token = await session.token()
      const { entries: sealed } = await api.vault(token)

      // One request returns the whole vault; everything after this is local.
      // The server cannot search or sort it, because it cannot read it.
      const opened = await Promise.all(
        sealed.map(async (e) => {
          try {
            return { ...(await openEntry(e.id, e.blob, state.vaultKey)), id: e.id, updatedAt: e.updatedAt }
          } catch {
            // One unreadable entry must not hide the rest.
            return { ...empty(), name: '[could not decrypt]', id: e.id, updatedAt: e.updatedAt }
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

  async function save(content: EntryContent, id?: string) {
    setError('')
    try {
      const entryId = id ?? crypto.randomUUID()
      const blob = await sealEntry(entryId, content, state.vaultKey)
      if (!isWithinSizeLimit(blob)) {
        setError('That entry is too large to store. Shorten the notes.')
        return
      }
      const token = await session.token()
      await api.putEntry(token, entryId, blob)
      setEditing(null)
      setSelected(null)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.')
    }
  }

  async function remove(id: string) {
    setError('')
    try {
      const token = await session.token()
      await api.deleteEntry(token, id)
      setSelected(null)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete.')
    }
  }

  return (
    <main>
      <div className="row between">
        <div>
          <h1>Vault</h1>
          <p className="sub small">{state.email} · {entries.length} entries</p>
        </div>
        <div className="row">
          <button onClick={() => { setSelected(null); setEditing(empty()) }}>New entry</button>
          <button className="secondary" onClick={session.lock}>Lock</button>
        </div>
      </div>

      {error ? <p className="error">{error}</p> : null}

      {editing ? (
        <EntryForm
          initial={editing}
          id={selected?.id}
          onCancel={() => setEditing(null)}
          onSave={save}
        />
      ) : selected ? (
        <EntryDetail
          entry={selected}
          onBack={() => setSelected(null)}
          onEdit={() => setEditing(selected)}
          onDelete={() => remove(selected.id)}
        />
      ) : loading ? (
        <p className="muted">Decrypting…</p>
      ) : entries.length === 0 ? (
        <div className="panel"><p className="muted">Nothing here yet.</p></div>
      ) : (
        <div className="stack">
          {entries.map((e) => (
            <div key={e.id} className="entry" onClick={() => setSelected(e)}
                 role="button" tabIndex={0}
                 onKeyDown={(k) => { if (k.key === 'Enter') setSelected(e) }}>
              <div className="name">{e.name || '(no name)'}</div>
              <div className="meta">{e.username || e.url || e.type}</div>
            </div>
          ))}
        </div>
      )}
    </main>
  )
}

function EntryDetail({ entry, onBack, onEdit, onDelete }: {
  entry: Decrypted; onBack: () => void; onEdit: () => void; onDelete: () => void
}) {
  const [revealed, setRevealed] = useState(false)
  return (
    <div className="panel">
      <div className="row between">
        <h2 style={{ margin: 0 }}>{entry.name || '(no name)'}</h2>
        <button className="secondary" onClick={onBack}>Back</button>
      </div>

      <Field label="Username" value={entry.username} />
      <div>
        <label>Password</label>
        <div className="row">
          <span className="secret">{revealed ? (entry.password || '—') : '••••••••••••'}</span>
          <button type="button" className="secondary" onClick={() => setRevealed(!revealed)}>
            {revealed ? 'Hide' : 'Reveal'}
          </button>
        </div>
      </div>
      <Field label="URL" value={entry.url} />
      <Field label="Notes" value={entry.notes} />

      <div className="row" style={{ marginTop: 20 }}>
        <button onClick={onEdit}>Edit</button>
        <button className="danger" onClick={onDelete}>Delete</button>
      </div>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string | undefined }) {
  return (
    <div>
      <label>{label}</label>
      <div className="secret">{value || <span className="muted">—</span>}</div>
    </div>
  )
}

function EntryForm({ initial, id, onCancel, onSave }: {
  initial: EntryContent
  id?: string | undefined
  onCancel: () => void
  onSave: (content: EntryContent, id?: string) => void
}) {
  const [draft, setDraft] = useState<EntryContent>(initial)
  const set = (k: keyof EntryContent) => (e: { target: { value: string } }) =>
    setDraft({ ...draft, [k]: e.target.value })

  return (
    <form className="panel" onSubmit={(e) => { e.preventDefault(); onSave(draft, id) }}>
      <h2 style={{ marginTop: 0 }}>{id ? 'Edit entry' : 'New entry'}</h2>

      <label htmlFor="f-name">Name</label>
      <input id="f-name" required value={draft.name} onChange={set('name')} />

      <label htmlFor="f-username">Username</label>
      <input id="f-username" value={draft.username ?? ''} onChange={set('username')} />

      <label htmlFor="f-password">Password</label>
      <input id="f-password" value={draft.password ?? ''} onChange={set('password')} />

      <label htmlFor="f-url">URL</label>
      <input id="f-url" value={draft.url ?? ''} onChange={set('url')} />

      <label htmlFor="f-notes">Notes</label>
      <textarea id="f-notes" rows={4} value={draft.notes ?? ''} onChange={set('notes')} />

      <div className="row" style={{ marginTop: 20 }}>
        <button type="submit" disabled={!draft.name}>Save</button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}
