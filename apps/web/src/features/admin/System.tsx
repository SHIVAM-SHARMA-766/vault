// Admin → System: server backups (C7), email templates (G6) and rate limits
// (G5). Backup settings live on the host; this shows them and can ask for a
// backup now.

import { ApiTokensCard } from './ApiTokens.js'
import { useEffect, useState } from 'react'

import { type BackupStatus, type TemplateKind, type Templates, api } from '../../lib/api.js'
import { when } from '../../lib/format.js'
import * as session from '../../lib/session.js'
import { IconAlert, IconRefresh } from '../../ui/icons.js'
import { useToast } from '../../ui/kit.js'
import { Section, ago, run } from './common.js'

type SystemTab = 'backups' | 'emails' | 'api' | 'limits'

export function System({ canWrite, canTokens = false }: { canWrite: boolean; canTokens?: boolean }) {
  // One subject at a time rather than one long page; the choice survives a reload.
  const tabs: { id: SystemTab; label: string }[] = [
    { id: 'backups', label: 'Backups' }, { id: 'emails', label: 'Emails' },
    ...(canTokens ? [{ id: 'api' as const, label: 'API & SCIM' }] : []), { id: 'limits', label: 'Sign-in limits' },
  ]
  const [tab, setTabState] = useState<SystemTab>(() => {
    const saved = (() => { try { return sessionStorage.getItem('vault.system.tab') } catch { return null } })()
    return tabs.some((t) => t.id === saved) ? (saved as SystemTab) : 'backups'
  })
  const setTab = (t: SystemTab) => { setTabState(t); try { sessionStorage.setItem('vault.system.tab', t) } catch { /* storage blocked */ } }
  return (
    <Section title="System" sub="Server backups, the emails Vault sends, API access, and the limits that protect sign-in.">
      <div className="segmented section-tabs" role="tablist" aria-label="System">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" id={`sys-tab-${t.id}`} aria-selected={tab === t.id} aria-controls="sys-panel"
                  className={tab === t.id ? 'seg-active' : ''} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>
      <div className="admin-grid" id="sys-panel" role="tabpanel" aria-labelledby={`sys-tab-${tab}`}>
        {tab === 'backups' ? <BackupCard canWrite={canWrite} /> : null}
        {tab === 'emails' ? <TemplatesCard canWrite={canWrite} /> : null}
        {tab === 'api' && canTokens ? <ApiTokensCard /> : null}
        {tab === 'limits' ? <LimitsCard /> : null}
      </div>
    </Section>
  )
}

function BackupCard({ canWrite }: { canWrite: boolean }) {
  const toast = useToast()
  const [b, setB] = useState<BackupStatus | null>(null)
  const load = async () => { try { setB(await api.admin.backup(await session.token())) } catch { /* says loading */ } }
  useEffect(() => { void load() }, [])
  if (!b) return <div className="admin-card admin-card-wide"><div className="admin-card-head"><h2>Server backups</h2></div><p className="muted small">Loading…</p></div>
  return (
    <div className="admin-card admin-card-wide" aria-labelledby="sys-backup">
      <div className="admin-card-head"><span className={`dot ${b.enabled ? 'dot-ok' : 'dot-warn'}`} /><h2 id="sys-backup">Server backups</h2>
        <button className="icon-btn" aria-label="Refresh backup status" onClick={() => void load()}><IconRefresh size={15} /></button></div>
      {b.enabled ? (
        <dl className="kv">
          <div><dt>Every</dt><dd>{b.intervalHours} hours</dd></div>
          <div><dt>Keeps</dt><dd>the last {b.keep} files on disk</dd></div>
          <div><dt>To</dt><dd>{b.destinations.map((d) => `${d.kind === 's3' ? 'S3 bucket' : 'folder'} ${d.where}`).join(' and ')}</dd></div>
          <div><dt>Encrypted</dt><dd>with BACKUP_PASSPHRASE (kept on the host)</dd></div>
          <div><dt>Last</dt><dd>{b.last ? `${ago(b.last.at)} · ${when(b.last.at)} · ${b.last.object}` : 'none yet'}</dd></div>
        </dl>
      ) : (
        <p className="alert alert-warn"><IconAlert size={16} /><span>Backups are off. Set <code>BACKUP_PASSPHRASE</code> and <code>BACKUP_DIR</code> or <code>BACKUP_S3_*</code> on the host (docs/INSTALL.md). They are not set here because the backup holds this database.</span></p>
      )}
      {b.requestedAt ? <p className="muted small" role="status">Backup asked for {ago(b.requestedAt)}; the server takes it within a minute.</p> : null}
      {canWrite && b.enabled ? (
        <div className="settings-actions">
          <button className="btn btn-secondary btn-sm" onClick={async () => { if (await run(toast, (t) => api.admin.backupNow(t), 'Backup asked for')) await load() }}>Back up now</button>
        </div>
      ) : null}
    </div>
  )
}

const KINDS: { kind: TemplateKind; label: string }[] = [
  { kind: 'verify', label: 'Sign-up code (OTP)' },
  { kind: 'invite', label: 'Invitation' },
  { kind: 'vaultApproved', label: 'Vault request approved' },
  { kind: 'accountReset', label: 'Account password reset link' },
  { kind: 'signIn', label: 'New sign-in notice' },
]

function TemplatesCard({ canWrite }: { canWrite: boolean }) {
  const toast = useToast()
  const [all, setAll] = useState<Templates | null>(null)
  const [kind, setKind] = useState<TemplateKind>('invite')
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [preview, setPreview] = useState<{ subject: string; text: string } | null>(null)
  useEffect(() => { void (async () => { try { setAll((await api.admin.settings(await session.token())).templates) } catch { setAll({}) } })() }, [])
  useEffect(() => { setSubject(all?.[kind]?.subject ?? ''); setMessage(all?.[kind]?.message ?? ''); setPreview(null) }, [kind, all])
  if (!all) return null
  const save = async (next: Templates, done: string) => { if (await run(toast, (t) => api.admin.setTemplates(t, next), done)) setAll(next) }
  return (
    <form className="admin-card admin-card-wide" aria-labelledby="sys-templates" onSubmit={(e) => {
      e.preventDefault()
      const next = { ...all }
      if (subject.trim() || message.trim()) next[kind] = { subject, message }; else delete next[kind]
      void save(next, 'Email template saved')
    }}>
      <div className="admin-card-head"><h2 id="sys-templates">Email templates</h2></div>
      <p className="muted small">Change the subject, and add a message above the standard text. Links, codes and security advice are always included. <code>{'{server}'}</code> becomes this server&apos;s name.</p>
      <div className="field">
        <label htmlFor="tpl-kind">Email</label>
        <select id="tpl-kind" value={kind} onChange={(e) => setKind(e.target.value as TemplateKind)}>
          {KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}{all[k.kind] ? ' (changed)' : ''}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="tpl-subject">Subject (empty for the standard one)</label>
        <input id="tpl-subject" maxLength={120} disabled={!canWrite} value={subject} onChange={(e) => setSubject(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="tpl-message">Your message (optional)</label>
        <textarea id="tpl-message" rows={4} maxLength={1000} disabled={!canWrite} value={message} onChange={(e) => setMessage(e.target.value)}
                  placeholder="e.g. Welcome! Questions? Ask the IT desk on extension 400." />
      </div>
      {preview ? (
        <div className="tpl-preview" aria-label="Preview">
          <p className="small"><strong>Subject:</strong> {preview.subject}</p>
          <pre>{preview.text}</pre>
        </div>
      ) : null}
      <div className="settings-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={async () => {
          try { setPreview(await api.admin.previewTemplate(await session.token(), kind, subject, message)) } catch (err) { toast(err instanceof Error ? err.message : 'Could not preview.', 'error') }
        }}>Preview</button>
        {canWrite && all[kind] ? <button type="button" className="btn btn-secondary btn-sm" onClick={() => { const next = { ...all }; delete next[kind]; void save(next, 'Back to the standard email') }}>Use the standard email</button> : null}
        {canWrite ? <button type="submit" className="btn btn-primary btn-sm">Save</button> : null}
      </div>
    </form>
  )
}

function LimitsCard() {
  const [limits, setLimits] = useState<{ name: string; per: string; max: number; windowSeconds: number; note: string }[] | null>(null)
  useEffect(() => { void (async () => { try { setLimits((await api.admin.limits(await session.token())).limits) } catch { setLimits([]) } })() }, [])
  const per = (s: number) => (s % 3600 === 0 ? (s === 3600 ? 'hour' : `${s / 3600} hours`) : s % 60 === 0 ? (s === 60 ? 'minute' : `${s / 60} minutes`) : `${s} s`)
  return (
    <div className="admin-card admin-card-wide" aria-labelledby="sys-limits">
      <div className="admin-card-head"><h2 id="sys-limits">Rate limits</h2></div>
      <p className="muted small">When someone is told to wait, this is why. Limits are part of the server&apos;s protection against guessing and abuse, so they are fixed.</p>
      {limits === null ? <p className="muted small">Loading…</p> : (
        <table className="limits">
          <thead><tr><th scope="col">What</th><th scope="col">Allowed</th><th scope="col">Counted per</th></tr></thead>
          <tbody>{limits.map((l) => (
            <tr key={l.name}><td>{l.name}{l.note ? <div className="muted small">{l.note}</div> : null}</td><td>{l.max.toLocaleString()} per {per(l.windowSeconds)}</td><td>{l.per}</td></tr>
          ))}</tbody>
        </table>
      )}
    </div>
  )
}
