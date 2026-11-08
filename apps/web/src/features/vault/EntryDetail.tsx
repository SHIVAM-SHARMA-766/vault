// One entry, read-only: its type's fields, custom fields, notes, tags, folder
// and history. Editing and deleting start here.

import { useEffect, useState } from 'react'

import type { EntryContent } from '@vault/crypto'
import { ISSUES, type Issue, folderPath, readField, typeSpec } from '@vault/core'

import { IconAlert, IconArrowLeft, IconClock, IconDownload, IconLink, IconUsers, IconEdit, IconInbox, IconRefresh, IconStar, IconTrash } from '../../ui/icons.js'
import { Monogram, typeInfo, useToast } from '../../ui/kit.js'
import { FieldView, SecretRow, TextRow } from './fields.js'
import { ShareLinkDialog } from './ShareLink.js'
import { describeSize, saveAttachment } from '../../lib/attachments.js'
import type { Decrypted, Folder, Version } from './model.js'
import { day, when } from '../../lib/format.js'
import { t } from '../../lib/i18n.js'

export interface SharedInfo { where: string; permission: 'view' | 'edit' | 'manage'; hidePasswords: boolean; sensitive?: boolean; onSensitive?: (v: boolean) => Promise<void> }

export function EntryDetail({ entry, folders, issues, vaultKey, linkMaxDays = 30, shared = null, shareTargets = [], onShare, onShareWithPerson, onUnshare, onAudit, onBack, onEdit, onToggleFavorite, onToggleArchive, onDelete, loadHistory, onRestore }: {
  entry: Decrypted
  folders: Folder[]
  issues: Issue[]
  /** Personal items only: lets the item be shared by link. */
  vaultKey?: Uint8Array | undefined
  /** The server's longest allowed share link, in days. */
  linkMaxDays?: number
  shared?: SharedInfo | null
  shareTargets?: { id: string; label: string }[]
  onShare?: (collectionId: string) => void
  /** Personal items: share with one person by address (D11). */
  onShareWithPerson?: ((email: string) => Promise<void>) | undefined
  onUnshare?: () => void
  /** For shared items: report opening, revealing and copying to the organization's audit. */
  onAudit?: (action: 'view' | 'reveal' | 'copy') => void
  onBack: () => void
  onEdit: () => void
  onToggleFavorite: () => void
  /** Absent for shared items: archiving one would hide it from everyone. */
  onToggleArchive?: (() => void) | undefined
  onDelete: () => void
  loadHistory: () => Promise<Version[]>
  onRestore: (content: EntryContent) => Promise<void>
}) {
  const toast = useToast()
  const [confirming, setConfirming] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [linking, setLinking] = useState(false)
  const [target, setTarget] = useState('')
  const [person, setPerson] = useState('')
  const readOnly = shared?.permission === 'view'
  const hidden = shared?.hidePasswords === true
  const secretKinds = new Set(['secret', 'secretBlock', 'totp'])
  useEffect(() => { if (shared) onAudit?.('view') }, [entry.id])
  // Reveal and copy buttons live inside the field components; one listener
  // here hears them all for the audit.
  const auditClick = (e: React.MouseEvent) => {
    if (!shared) return
    const label = (e.target as HTMLElement).closest('button')?.getAttribute('aria-label') ?? ''
    if (/^Copy /.test(label)) onAudit?.('copy')
    else if (/^Reveal /.test(label)) onAudit?.('reveal')
  }
  const info = typeInfo(entry.type)
  const spec = typeSpec(entry.type)
  const path = folderPath(folders, entry.folderId)

  return (
    <article className="detail">
      <div className="detail-bar">
        <button className="btn btn-ghost back-sm" onClick={onBack}><IconArrowLeft size={16} />{t('Back')}</button>
        <div className="detail-actions">
          <button className={`icon-btn ${entry.favorite ? 'is-fav' : ''}`} onClick={onToggleFavorite} disabled={entry.unreadable}
                  title={entry.favorite ? 'Remove from favorites' : 'Add to favorites'} aria-label="Toggle favorite">
            <IconStar size={16} filled={entry.favorite} />
          </button>
          {shared ? null : (
            <button className={`btn btn-secondary btn-sm ${showHistory ? 'btn-pressed' : ''}`} onClick={() => setShowHistory(!showHistory)}
                    disabled={entry.unreadable} aria-pressed={showHistory} aria-label={t('History')}><IconClock size={15} /><span className="btn-label">{t('History')}</span></button>
          )}
          {!shared && (shareTargets.length || onShareWithPerson) ? (
            <button className={`btn btn-secondary btn-sm ${sharing ? 'btn-pressed' : ''}`} onClick={() => setSharing(!sharing)} aria-label={t('Share')}><IconUsers size={15} /><span className="btn-label">{t('Share')}</span></button>
          ) : null}
          {vaultKey && !shared ? (
            <button className="btn btn-secondary btn-sm" onClick={() => setLinking(true)} disabled={entry.unreadable} aria-label="Share by link"><IconLink size={15} /><span className="btn-label">{t('Link')}</span></button>
          ) : null}
          {onToggleArchive ? (
            <button className="btn btn-secondary btn-sm" onClick={onToggleArchive} disabled={entry.unreadable}
                    aria-label={entry.archived ? 'Restore from archive' : 'Archive'}><IconInbox size={15} /><span className="btn-label">{entry.archived ? 'Restore' : 'Archive'}</span></button>
          ) : null}
          <button className="btn btn-secondary btn-sm" onClick={onEdit} disabled={entry.unreadable || readOnly} aria-label={t('Edit')}><IconEdit size={15} /><span className="btn-label">{t('Edit')}</span></button>
          <button className="btn btn-danger-ghost btn-sm" onClick={() => setConfirming(true)} disabled={readOnly} aria-label={t('Delete')}><IconTrash size={15} /><span className="btn-label">{t('Delete')}</span></button>
        </div>
      </div>

      <header className="detail-head">
        <Monogram name={entry.name} size="lg" />
        <div>
          <h2>{entry.name || 'Untitled'}</h2>
          <div className="detail-meta">
            <span className="badge"><info.Icon size={13} />{t(info.label)}</span>
            {path && !shared ? <span className="badge badge-folder">{path}</span> : null}
            {shared ? <span className="badge badge-shared"><IconUsers size={13} />{shared.where}</span> : null}
            {readOnly ? <span className="badge">View only</span> : null}
            {shared?.sensitive ? <span className="badge badge-sensitive" title="The organization's admins are told when this is opened">Sensitive</span> : null}
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

      {sharing ? (
        <div className="confirm">
          {onShareWithPerson ? (
            <form className="share-person" onSubmit={async (e) => { e.preventDefault(); await onShareWithPerson(person); setPerson(''); setSharing(false) }}>
              <p><strong>Share “{entry.name}” with a person</strong> who has an account on this server. It moves to a space only the two of you share, encrypted to their key once you have checked their fingerprint.</p>
              <div className="confirm-actions">
                <input type="email" required aria-label="Their email address" placeholder="Their email address" value={person} onChange={(e) => setPerson(e.target.value)} />
                <button type="submit" className="btn btn-primary btn-sm" disabled={!person.trim()}>{t('Share')}</button>
              </div>
            </form>
          ) : null}
          {shareTargets.length ? (
            <>
              <p><strong>Or move it into a collection.</strong> It is re-encrypted with the collection’s key and leaves your personal vault; everyone who can open the collection can read it.</p>
              <div className="confirm-actions">
                <select aria-label="Collection" value={target} onChange={(e) => setTarget(e.target.value)}>
                  <option value="">Choose a collection…</option>
                  {shareTargets.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
                <button className="btn btn-primary btn-sm" disabled={!target} onClick={() => { onShare?.(target); setSharing(false) }}>Move to collection</button>
              </div>
            </>
          ) : null}
          <div className="confirm-actions"><button className="btn btn-secondary btn-sm" onClick={() => setSharing(false)}>Cancel</button></div>
        </div>
      ) : null}

      {shared && !readOnly ? (
        <p className="muted small shared-note">Shared in {shared.where}. <button className="link" onClick={onUnshare}>Move to my vault</button></p>
      ) : null}
      {shared?.onSensitive ? (
        <label className="check sensitive-toggle"><input type="checkbox" checked={!!shared.sensitive} onChange={(e) => void shared.onSensitive!(e.target.checked)} />
          <span>Tell the admins whenever someone opens this</span></label>
      ) : shared?.sensitive ? <p className="muted small">Sensitive: the organization&apos;s admins are told when it is opened, revealed or copied.</p> : null}

      {linking && vaultKey ? <ShareLinkDialog entry={entry} vaultKey={vaultKey} maxDays={linkMaxDays} onClose={() => setLinking(false)} /> : null}

      {showHistory ? <History entry={entry} load={loadHistory} onRestore={onRestore} /> : null}

      <div className="fields" onClickCapture={auditClick}>
        {spec.fields.map((field) => hidden && secretKinds.has(field.kind)
          ? <div key={field.key} className="field-row"><span className="field-label">{field.label}</span><span className="muted small">Hidden by your organization’s policy</span></div>
          : <FieldView key={field.key} spec={field} value={readField(entry, field)} entryType={entry.type} />)}
        {entry.customFields.map((c, i) =>
          c.hidden ? (hidden ? <div key={`c${i}`} className="field-row"><span className="field-label">{c.label || 'Hidden field'}</span><span className="muted small">Hidden by your organization’s policy</span></div>
                             : <SecretRow key={`c${i}`} label={c.label || 'Hidden field'} value={c.value} />)
                   : <TextRow key={`c${i}`} label={c.label || 'Field'} value={c.value} />)}
      </div>

      {entry.attachments?.length ? (
        <div className="notes">
          <span className="field-label">{t('Attachments')}</span>
          <ul className="attachment-list">
            {entry.attachments.map((a) => (
              <li key={a.id}>
                <span className="truncate">{a.name}</span><span className="muted small">{describeSize(a.size)}</span>
                <button className="btn btn-ghost btn-sm" aria-label={`Download ${a.name}`} onClick={() => { void saveAttachment(a).catch((err: unknown) => toast(err instanceof Error ? err.message : 'Could not open the file.', 'error')) }}><IconDownload size={14} />Download</button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {entry.notes ? (
        <div className="notes">
          <span className="field-label">{t('Notes')}</span>
          <pre>{entry.notes}</pre>
        </div>
      ) : null}

      {entry.tags.length ? (
        <div className="tags">{entry.tags.map((t) => <span key={t} className="tag">{t}</span>)}</div>
      ) : null}

      <p className="detail-foot">Last modified {formatDate(entry.updatedAt)}{entry.rotateDays && entry.password ? (
        <> · Change reminder every {entry.rotateDays} days, next {day(new Date(Date.parse(entry.passwordChangedAt ?? entry.updatedAt) + entry.rotateDays * 86_400_000).toISOString())}</>
      ) : null}</p>
    </article>
  )
}

export function formatDate(iso: string): string {
  return when(iso)
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
    <section className="history" aria-label={t('History')}>
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
