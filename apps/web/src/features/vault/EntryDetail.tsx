// One entry, read-only: its type's fields, custom fields, notes, tags, folder
// and history. Editing and deleting start here.

import { useEffect, useState } from 'react'

import type { EntryContent } from '@vault/crypto'
import { ISSUES, type Issue, folderPath, readField, typeSpec } from '@vault/core'

import { IconAlert, IconArrowLeft, IconClock, IconEdit, IconRefresh, IconStar, IconTrash } from '../../ui/icons.js'
import { Monogram, typeInfo, useToast } from '../../ui/kit.js'
import { FieldView, SecretRow, TextRow } from './fields.js'
import type { Decrypted, Folder, Version } from './model.js'

export function EntryDetail({ entry, folders, issues, onBack, onEdit, onToggleFavorite, onDelete, loadHistory, onRestore }: {
  entry: Decrypted
  folders: Folder[]
  issues: Issue[]
  onBack: () => void
  onEdit: () => void
  onToggleFavorite: () => void
  onDelete: () => void
  loadHistory: () => Promise<Version[]>
  onRestore: (content: EntryContent) => Promise<void>
}) {
  const [confirming, setConfirming] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const info = typeInfo(entry.type)
  const spec = typeSpec(entry.type)
  const path = folderPath(folders, entry.folderId)

  return (
    <article className="detail">
      <div className="detail-bar">
        <button className="btn btn-ghost back-sm" onClick={onBack}><IconArrowLeft size={16} />Back</button>
        <div className="detail-actions">
          <button className={`icon-btn ${entry.favorite ? 'is-fav' : ''}`} onClick={onToggleFavorite} disabled={entry.unreadable}
                  title={entry.favorite ? 'Remove from favorites' : 'Add to favorites'} aria-label="Toggle favorite">
            <IconStar size={16} filled={entry.favorite} />
          </button>
          <button className={`btn btn-secondary btn-sm ${showHistory ? 'btn-pressed' : ''}`} onClick={() => setShowHistory(!showHistory)}
                  disabled={entry.unreadable} aria-pressed={showHistory}><IconClock size={15} />History</button>
          <button className="btn btn-secondary btn-sm" onClick={onEdit} disabled={entry.unreadable}><IconEdit size={15} />Edit</button>
          <button className="btn btn-danger-ghost btn-sm" onClick={() => setConfirming(true)}><IconTrash size={15} />Delete</button>
        </div>
      </div>

      <header className="detail-head">
        <Monogram name={entry.name} size="lg" />
        <div>
          <h2>{entry.name || 'Untitled'}</h2>
          <div className="detail-meta">
            <span className="badge"><info.Icon size={13} />{info.label}</span>
            {path ? <span className="badge badge-folder">{path}</span> : null}
          </div>
        </div>
      </header>

      {confirming ? (
        <div className="confirm">
          <p><strong>Delete “{entry.name || 'Untitled'}”?</strong> This cannot be undone, and its history goes with it.</p>
          <div className="confirm-actions">
            <button className="btn btn-secondary btn-sm" onClick={() => setConfirming(false)}>Cancel</button>
            <button className="btn btn-danger btn-sm" onClick={onDelete}>Delete permanently</button>
          </div>
        </div>
      ) : null}

      {issues.length ? (
        <div className="alert alert-warn health-issues" role="note">
          <IconAlert size={16} />
          <ul>{issues.map((i) => { const x = ISSUES.find((y) => y.issue === i)!; return <li key={i}><strong>{x.label}.</strong> {x.advice}</li> })}</ul>
        </div>
      ) : null}

      {showHistory ? <History entry={entry} load={loadHistory} onRestore={onRestore} /> : null}

      <div className="fields">
        {spec.fields.map((field) => <FieldView key={field.key} spec={field} value={readField(entry, field)} entryType={entry.type} />)}
        {entry.customFields.map((c, i) =>
          c.hidden ? <SecretRow key={`c${i}`} label={c.label || 'Hidden field'} value={c.value} />
                   : <TextRow key={`c${i}`} label={c.label || 'Field'} value={c.value} />)}
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

export function formatDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** What differs between a past version and the entry now, in words. */
function changes(past: EntryContent, now: EntryContent): string[] {
  const out: string[] = []
  if (past.name !== now.name) out.push('name')
  for (const field of typeSpec(now.type).fields) {
    if (readField(past, field) !== readField(now, field)) out.push(field.label.toLowerCase())
  }
  if ((past.notes ?? '') !== (now.notes ?? '')) out.push('notes')
  if (JSON.stringify(past.customFields) !== JSON.stringify(now.customFields)) out.push('custom fields')
  if (past.type !== now.type) out.push('type')
  return out
}

function History({ entry, load, onRestore }: { entry: Decrypted; load: () => Promise<Version[]>; onRestore: (c: EntryContent) => Promise<void> }) {
  const toast = useToast()
  const [versions, setVersions] = useState<Version[] | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    load().then((v) => { if (alive) setVersions(v) }).catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : 'Could not load history.') })
    return () => { alive = false }
  }, [entry.updatedAt])

  return (
    <section className="history" aria-label="History">
      <div className="history-head">
        <h3>Previous versions</h3>
        <span className="muted small">Kept automatically on every edit, up to 20, encrypted like the entry.</span>
      </div>
      {error ? <p className="muted small">{error}</p> : versions === null ? <p className="muted small">Decrypting…</p>
        : versions.length === 0 ? <p className="muted small">No earlier versions yet. Editing this entry keeps the old one here.</p> : (
        <ul className="history-list">
          {versions.map((v) => {
            const diff = changes(v.content, entry)
            const pw = v.content.password && v.content.password !== entry.password ? v.content.password : ''
            return (
              <li key={v.at} className="history-item">
                <button className="history-row" onClick={() => setOpen(open === v.at ? null : v.at)} aria-expanded={open === v.at}>
                  <span>{formatDate(v.at)}</span>
                  <span className="muted small">{diff.length ? `Changed since: ${diff.join(', ')}` : 'Same as now'}</span>
                </button>
                {open === v.at ? (
                  <div className="history-body">
                    {pw ? <SecretRow label="Password then" value={pw} /> : null}
                    {v.content.name !== entry.name ? <TextRow label="Name then" value={v.content.name} copy={false} /> : null}
                    <button className="btn btn-secondary btn-sm" onClick={async () => {
                      try { await onRestore(v.content); toast('Version restored. The one it replaced is in history.') }
                      catch (e) { toast(e instanceof Error ? e.message : 'Could not restore.', 'error') }
                    }}><IconRefresh size={14} />Restore this version</button>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
