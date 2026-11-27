// The staff audit log, filtered and paged on the server: by action, by text
// (a label, an address, a detail), by date; exported whole as CSV or JSON.

import { useCallback, useEffect, useRef, useState } from 'react'

import { type AdminAudit, type AdminAuditQuery, api } from '../../lib/api.js'
import { download } from '../../lib/download.js'
import * as session from '../../lib/session.js'
import { IconDownload, IconRefresh, IconSearch } from '../../ui/icons.js'
import { useToast } from '../../ui/kit.js'
import { ErrorBox, Section, when } from './common.js'

export const ACTIONS: Record<string, string> = {
  'settings.registration': 'Changed registration',
  'invite.create': 'Created invitation',
  'invite.delete': 'Revoked invitation',
  'user.label': 'Relabelled account',
  'user.disable': 'Disabled account',
  'user.enable': 'Enabled account',
  'user.revoke-sessions': 'Signed account out everywhere',
  'user.delete': 'Deleted account',
  'user.role': 'Changed role',
  'user.reset-2fa': 'Reset two-factor sign-in',
  'site.publish': 'Published the website',
  'site.rollback': 'Rolled the website back',
  'site.discard-draft': 'Discarded the website draft',
  'media.upload': 'Uploaded an image',
  'media.delete': 'Deleted an image',
}
export const actionName = (a: string) => ACTIONS[a] ?? a

type Page = { records: AdminAudit[]; total: number; offset: number; limit: number; actions: string[] }

export function Audit() {
  const toast = useToast()
  const [query, setQuery] = useState<AdminAuditQuery>({ limit: 100, offset: 0 })
  const [text, setText] = useState('')
  const [page, setPage] = useState<Page | null>(null)
  const [error, setError] = useState('')
  const seq = useRef(0)
  const load = useCallback(async (q: AdminAuditQuery) => {
    const n = ++seq.current
    setError('')
    try { const res = await api.admin.audit(await session.token(), q); if (n === seq.current) setPage(res) }
    catch (err) { if (n === seq.current) setError(err instanceof Error ? err.message : 'Could not load.') }
  }, [])
  useEffect(() => { void load(query) }, [query, load])
  useEffect(() => {
    const t = setTimeout(() => setQuery((q) => (q.q ?? '') === text.trim() ? q : { ...q, q: text.trim(), offset: 0 }), 250)
    return () => clearTimeout(t)
  }, [text])
  const set = (patch: Partial<AdminAuditQuery>) => setQuery((q) => ({ ...q, offset: 0, ...patch }))
  const filtered = !!(query.action || query.q || query.from || query.to)
  const from = page && page.total ? page.offset + 1 : 0
  const to = page ? Math.min(page.offset + page.records.length, page.total) : 0

  return (
    <Section title="Audit log" sub="Every admin action, kept as long as the audit retention policy says. Written before the action runs, so nothing here happens unrecorded."
             actions={<>
               {(['csv', 'json'] as const).map((f) => (
                 <button key={f} className="btn btn-secondary btn-sm" onClick={async () => {
                   try { download(`vault-audit-${new Date().toISOString().slice(0, 10)}.${f}`, await api.admin.auditExport(await session.token(), f), f === 'csv' ? 'text/csv' : 'application/json') }
                   catch (err) { toast(err instanceof Error ? err.message : 'Could not export.', 'error') }
                 }}><IconDownload size={15} />{f.toUpperCase()}</button>
               ))}
               <button className="btn btn-secondary btn-sm" onClick={() => void load(query)}><IconRefresh size={15} />Refresh</button>
             </>}>
      <div className="table-toolbar">
        <label className="search-field">
          <IconSearch size={15} />
          <input type="search" placeholder="Search by account, address or detail" aria-label="Search the audit log" value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <select aria-label="Action" value={query.action ?? ''} onChange={(e) => set({ action: e.target.value })}>
          <option value="">Every action</option>
          {(page?.actions ?? []).map((a) => <option key={a} value={a}>{actionName(a)}</option>)}
        </select>
        <label className="date-field">From <input type="date" aria-label="From" value={query.from ?? ''} onChange={(e) => set({ from: e.target.value })} /></label>
        <label className="date-field">To <input type="date" aria-label="To" value={query.to ?? ''} onChange={(e) => set({ to: e.target.value })} /></label>
        {filtered ? <button className="link" onClick={() => { setText(''); setQuery({ limit: query.limit ?? 100, offset: 0 }) }}>Clear filters</button> : null}
      </div>
      <ErrorBox error={error} />
      {!page ? <div className="skeletons">{[0, 1, 2].map((i) => <div key={i} className="skeleton" />)}</div>
        : page.total === 0 ? <div className="empty"><h3>{filtered ? 'Nothing matches' : 'No admin actions yet'}</h3></div> : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>When</th><th>Action</th><th>Detail</th><th>By</th></tr></thead>
            <tbody>
              {page.records.map((r, i) => (
                <tr key={`${r.at}-${i}`}>
                  <td>{when(r.at)}</td>
                  <td className="strong">{actionName(r.action)}</td>
                  <td>{[r.targetLabel ?? (r.target ? `${r.target.slice(0, 8)}…` : null), r.detail].filter(Boolean).join(' · ') || '—'}</td>
                  <td>{r.actorLabel ?? <code className="acct-id">{r.actor.slice(0, 8)}…</code>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {page && page.total > 0 ? (
        <div className="pager">
          <span className="muted small">{from}–{to} of {page.total}</span>
          <button className="btn btn-secondary btn-sm" disabled={page.offset === 0} onClick={() => setQuery((q) => ({ ...q, offset: Math.max(0, (q.offset ?? 0) - (q.limit ?? 100)) }))}>Previous</button>
          <button className="btn btn-secondary btn-sm" disabled={to >= page.total} onClick={() => setQuery((q) => ({ ...q, offset: (q.offset ?? 0) + (q.limit ?? 100) }))}>Next</button>
        </div>
      ) : null}
    </Section>
  )
}
