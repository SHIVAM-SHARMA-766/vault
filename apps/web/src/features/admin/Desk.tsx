// The service desk, for staff: the queue, one ticket's conversation with
// internal notes, status / priority / assignment, and the two actions that
// close the common requests — approve access, reset two-factor sign-in.

import { useCallback, useEffect, useMemo, useState } from 'react'

import { type Role, type StaffTicket, type TicketMessage, type TicketStatus, api } from '../../lib/api.js'
import * as session from '../../lib/session.js'
import { IconAlert, IconArrowLeft, IconCheck, IconShield } from '../../ui/icons.js'
import { CopyButton, useToast } from '../../ui/kit.js'
import { ErrorBox, Section, ago, run, useAdminData, when } from './common.js'

const KIND_LABEL = { access: 'Access request', signin: 'Sign-in help', support: 'Support' } as const
/** Staff wording; the requester sees "Waiting for you" for the same state. */
const STATUS_LABEL: Record<TicketStatus, string> = {
  open: 'Open', in_progress: 'In progress', waiting: 'Waiting on requester', resolved: 'Resolved', closed: 'Closed',
}
const fromLabel = (t: StaffTicket) => t.requester.name ?? (t.kind === 'support' ? 'Signed-in member' : '—')
const FILTERS: { id: string; label: string; match: (t: StaffTicket) => boolean }[] = [
  { id: 'active', label: 'Needs attention', match: (t) => t.status === 'open' || t.status === 'in_progress' },
  { id: 'waiting', label: 'Waiting on requester', match: (t) => t.status === 'waiting' },
  { id: 'resolved', label: 'Resolved', match: (t) => t.status === 'resolved' },
  { id: 'closed', label: 'Closed', match: (t) => t.status === 'closed' },
  { id: 'all', label: 'All', match: () => true },
]

const loadQueue = (t: string) => api.admin.desk(t)

export function Desk({ selfId, canWrite, canApprove, canReset }: { selfId: string; canWrite: boolean; canApprove: boolean; canReset: boolean }) {
  const { data, error, reload } = useAdminData(loadQueue)
  const [filter, setFilter] = useState('active')
  const [openId, setOpenId] = useState<string | null>(null)
  const visible = useMemo(() => (data?.tickets ?? []).filter(FILTERS.find((f) => f.id === filter)!.match), [data, filter])

  if (openId) {
    return <TicketView id={openId} selfId={selfId} canWrite={canWrite} canApprove={canApprove} canReset={canReset}
                       onBack={() => { setOpenId(null); void reload() }} />
  }
  return (
    <Section title="Service desk" sub="Access requests, sign-in help and support tickets. Staff can read tickets; nobody here can read a vault.">
      <ErrorBox error={error} />
      <div className="health-chips desk-filters">
        {FILTERS.map((f) => (
          <button key={f.id} className={`chip ${filter === f.id ? 'chip-active' : ''}`} onClick={() => setFilter(f.id)}>
            {f.label} {data ? (data.tickets ?? []).filter(f.match).length : ''}
          </button>
        ))}
      </div>
      {!data ? <div className="skeletons">{[0, 1, 2].map((i) => <div key={i} className="skeleton" />)}</div>
        : visible.length === 0 ? <div className="empty"><h3>Nothing here</h3><p>No tickets in this view.</p></div> : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>#</th><th>Subject</th><th>Kind</th><th>From</th><th>Status</th><th>Updated</th></tr></thead>
            <tbody>
              {visible.map((t) => (
                <tr key={t.id} className="row-link" onClick={() => setOpenId(t.id)}>
                  <td className="num">{t.number}</td>
                  <td>
                    <button className="link-strong" onClick={() => setOpenId(t.id)}>{t.subject}</button>
                    {t.priority === 'high' ? <span className="pill pill-danger">High</span> : null}
                    {t.lastFrom === 'requester' && t.status !== 'closed' ? <span className="pill pill-accent">Awaiting reply</span> : null}
                  </td>
                  <td>{KIND_LABEL[t.kind]}</td>
                  <td>{fromLabel(t)}</td>
                  <td><span className={`pill status-${t.status}`}>{STATUS_LABEL[t.status]}</span></td>
                  <td title={when(t.updatedAt)}>{ago(t.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}

function TicketView({ id, selfId, canWrite, canApprove, canReset, onBack }: {
  id: string; selfId: string; canWrite: boolean; canApprove: boolean; canReset: boolean; onBack: () => void
}) {
  const toast = useToast()
  const [data, setData] = useState<{ ticket: StaffTicket; messages: TicketMessage[] } | null>(null)
  const [reply, setReply] = useState('')
  const [internal, setInternal] = useState(false)
  const [issued, setIssued] = useState<{ code: string; emailed: boolean } | null>(null)
  const [role, setRole] = useState<Role>('user')
  const load = useCallback(async () => setData(await api.admin.ticket(await session.token(), id)), [id])
  useEffect(() => { void load() }, [load])
  if (!data) return <Section title="Service desk"><div className="skeletons"><div className="skeleton" /></div></Section>
  const t = data.ticket
  const closed = t.status === 'closed'
  const update = async (patch: Parameters<typeof api.admin.updateTicket>[2], done: string) => {
    if (await run(toast, (tok) => api.admin.updateTicket(tok, id, patch), done)) await load()
  }

  return (
    <Section title={`#${t.number} ${t.subject}`} sub={`${KIND_LABEL[t.kind]} · opened ${when(t.createdAt)}`}
             actions={<button className="btn btn-secondary btn-sm" onClick={onBack}><IconArrowLeft size={15} />Queue</button>}>
      <div className="desk-grid">
        <div className="thread">
          {data.messages.map((m, i) => (
            <div key={i} className={`bubble bubble-${m.internal ? 'internal' : m.from}`}>
              <span className="bubble-meta">{m.internal ? 'Internal note · ' : ''}{m.author} · {when(m.at)}</span>
              <p>{m.body}</p>
            </div>
          ))}
          {canWrite && !closed ? (
            <form className="thread-reply" onSubmit={async (e) => {
              e.preventDefault()
              if (await run(toast, (tok) => api.admin.replyTicket(tok, id, reply.trim(), internal), internal ? 'Note added' : 'Reply sent')) { setReply(''); await load() }
            }}>
              <textarea aria-label="Reply" rows={3} maxLength={5000} placeholder={internal ? 'A note only staff can see' : 'Reply to the requester'} value={reply} onChange={(e) => setReply(e.target.value)} />
              <div className="settings-actions">
                <label className="check"><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /><span>Internal note</span></label>
                <button type="submit" className="btn btn-primary btn-sm" disabled={!reply.trim()}>{internal ? 'Add note' : 'Send reply'}</button>
              </div>
              {!internal && !t.requester.email && t.kind !== 'support' ? <p className="hint">This requester has no address on file; they will not be told.</p> : null}
            </form>
          ) : null}
        </div>

        <aside className="desk-side">
          <div className="admin-card">
            <h2 className="small-head">Requester</h2>
            <p>{fromLabel(t)}</p>
            <p className="muted small">{t.requester.email ?? (t.requester.emailErased ? 'Address erased when closed' : t.kind === 'support' ? 'Signed-in user; no email updates' : '—')}</p>
          </div>

          {canWrite ? (
            <div className="admin-card">
              <h2 className="small-head">Ticket</h2>
              <div className="field"><label htmlFor="d-status">Status</label>
                <select id="d-status" value={t.status} onChange={(e) => void update({ status: e.target.value as TicketStatus }, 'Status changed')}>
                  {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
              <div className="field"><label htmlFor="d-priority">Priority</label>
                <select id="d-priority" value={t.priority} onChange={(e) => void update({ priority: e.target.value as 'normal' | 'high' }, 'Priority changed')}>
                  <option value="normal">Normal</option><option value="high">High</option>
                </select>
              </div>
              <p className="muted small">{t.assignee ? (t.assignee === selfId ? 'Assigned to you' : 'Assigned to another staff member') : 'Unassigned'}</p>
              <button className="btn btn-secondary btn-sm" onClick={() => void update({ assignee: t.assignee === selfId ? null : selfId }, t.assignee === selfId ? 'Unassigned' : 'Assigned to you')}>
                {t.assignee === selfId ? 'Unassign me' : 'Assign to me'}
              </button>
            </div>
          ) : null}

          {t.kind === 'access' && canApprove && !closed ? (
            <div className="admin-card">
              <h2 className="small-head">Approve access</h2>
              <p className="muted small">Issues a single-use invitation{t.requester.email ? ' and emails it' : ''}, and resolves the ticket.</p>
              <div className="field"><label htmlFor="d-role">Starts as</label>
                <select id="d-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
                  {(['user', 'viewer', 'support', 'marketing', 'admin'] as Role[]).map((r) => <option key={r} value={r}>{r[0]!.toUpperCase() + r.slice(1)}</option>)}
                </select>
              </div>
              <button className="btn btn-primary btn-sm" onClick={async () => {
                try { const r = await api.admin.approveAccess(await session.token(), id, role); setIssued({ code: r.code, emailed: r.emailed }); toast(r.emailed ? 'Invitation emailed' : 'Invitation issued'); await load() }
                catch (err) { toast(err instanceof Error ? err.message : 'Could not approve.', 'error') }
              }}><IconCheck size={15} />Approve and invite</button>
            </div>
          ) : null}
          {issued ? (
            <div className="admin-card">
              <h2 className="small-head">Invitation</h2>
              <p className="muted small">{issued.emailed ? 'Emailed to the requester. ' : 'Send this to the requester. '}Shown once.</p>
              <div className="recovery-key"><code>{issued.code}</code><CopyButton value={issued.code} label="Invitation code" /></div>
            </div>
          ) : null}

          {t.kind === 'signin' && !closed ? (
            <div className="admin-card card-warn">
              <h2 className="small-head"><IconShield size={15} /> Reset two-factor sign-in</h2>
              <p className="muted small"><IconAlert size={13} /> First confirm it is really them — call them, or ask in person. Anyone can type an address into this form.</p>
              {canReset ? (
                <button className="btn btn-danger btn-sm" onClick={async () => {
                  if (!window.confirm('Turn off two-factor sign-in for the account with this address? Do this only after confirming the person.')) return
                  try { const r = await api.admin.resetTicket2fa(await session.token(), id); toast(r.hadTwoFactor ? 'Two-factor sign-in reset' : 'That account did not have two-factor sign-in on'); await load() }
                  catch (err) { toast(err instanceof Error ? err.message : 'Could not reset.', 'error') }
                }}>Reset for this account</button>
              ) : <p className="muted small">Needs an admin. Add an internal note and assign it to one.</p>}
            </div>
          ) : null}
        </aside>
      </div>
    </Section>
  )
}
