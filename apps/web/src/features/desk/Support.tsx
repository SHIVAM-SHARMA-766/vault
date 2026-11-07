// Help & support for signed-in users: their tickets, a new one, and the
// conversation with the people who run the server.

import { useCallback, useEffect, useState } from 'react'

import { type Ticket, type TicketMessage, api } from '../../lib/api.js'
import { SupportContact } from '../../lib/instance.js'
import { Link } from '../../lib/router.js'
import * as session from '../../lib/session.js'
import { IconAlert, IconHelp, IconPlus } from '../../ui/icons.js'
import { Check, useToast } from '../../ui/kit.js'
import { Shell } from '../../ui/Shell.js'

export const STATUS_LABEL: Record<string, string> = {
  open: 'Open', in_progress: 'In progress', waiting: 'Waiting for you', resolved: 'Resolved', closed: 'Closed',
}
const CATEGORY_LABEL: Record<string, string> = { question: 'Question', problem: 'Something is not working', account: 'My account', feature: 'Suggestion' }
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export function Support({ state }: { state: session.Unlocked }) {
  const toast = useToast()
  const [tickets, setTickets] = useState<Ticket[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)

  const load = useCallback(async () => {
    try { setTickets((await api.desk.mine(await session.token())).tickets) } catch (err) { toast(err instanceof Error ? err.message : 'Could not load.', 'error') }
  }, [])
  useEffect(() => { void load() }, [load])

  return (
    <Shell state={state}>
      <main className="settings">
        <div className="settings-head">
          <ol className="crumbs crumbs-admin" aria-label="Breadcrumb">
            <li><Link to="/app/">Vault</Link></li>
            <li aria-current="page">Help &amp; support</li>
          </ol>
          <h1>Help &amp; support</h1>
          <p className="muted">Ask the people who run this server. They can see what you write here, but never your vault — so never put a password in a request.</p>
          <SupportContact />
        </div>

        {composing ? <NewTicket email={state.email} onCancel={() => setComposing(false)} onCreated={async (id) => { setComposing(false); await load(); setOpen(id) }} /> : (
          <div className="settings-actions settings-actions-left"><button className="btn btn-primary" onClick={() => setComposing(true)}><IconPlus size={16} />New request</button></div>
        )}

        <section className="settings-card" aria-labelledby="s-tickets">
          <div className="settings-card-head"><IconHelp size={18} /><h2 id="s-tickets">Your requests</h2></div>
          {tickets === null ? <p className="muted small">Loading…</p> : tickets.length === 0 ? <p className="muted small">No requests yet.</p> : (
            <ul className="ticket-list">
              {tickets.map((t) => (
                <li key={t.id}>
                  <button className={`ticket-row ${open === t.id ? 'row-active' : ''}`} onClick={() => setOpen(open === t.id ? null : t.id)} aria-expanded={open === t.id}>
                    <span className="ticket-num">#{t.number}</span>
                    <span className="ticket-subject">{t.subject}</span>
                    <span className={`pill status-${t.status}`}>{STATUS_LABEL[t.status]}</span>
                  </button>
                  {open === t.id ? <Conversation id={t.id} onChanged={load} /> : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </Shell>
  )
}

function NewTicket({ email, onCancel, onCreated }: { email: string; onCancel: () => void; onCreated: (id: string) => Promise<void> }) {
  const toast = useToast()
  const [subject, setSubject] = useState('')
  const [category, setCategory] = useState('question')
  const [message, setMessage] = useState('')
  const [updates, setUpdates] = useState(true)
  const [busy, setBusy] = useState(false)
  return (
    <form className="settings-card" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true)
      try {
        const { ticket } = await api.desk.create(await session.token(), { subject: subject.trim(), category, message: message.trim(), ...(updates ? { email } : {}) })
        toast(`Request #${ticket.number} sent`)
        await onCreated(ticket.id)
      } catch (err) { toast(err instanceof Error ? err.message : 'Could not send.', 'error'); setBusy(false) }
    }}>
      <div className="settings-card-head"><IconPlus size={18} /><h2>New request</h2></div>
      <div className="grid-2">
        <div className="field"><label htmlFor="t-subject">Subject</label><input id="t-subject" required maxLength={120} value={subject} onChange={(e) => setSubject(e.target.value)} /></div>
        <div className="field"><label htmlFor="t-category">About</label>
          <select id="t-category" value={category} onChange={(e) => setCategory(e.target.value)}>
            {Object.entries(CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
      </div>
      <div className="field"><label htmlFor="t-message">Details</label><textarea id="t-message" required rows={5} maxLength={5000} value={message} onChange={(e) => setMessage(e.target.value)} /></div>
      <p className="alert alert-warn"><IconAlert size={16} />Never include a password, a recovery key or a one-time code.</p>
      <Check checked={updates} onChange={setUpdates}>Email replies to {email} (kept only until the request is closed)</Check>
      <div className="settings-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={busy || !subject.trim() || !message.trim()}>Send</button>
      </div>
    </form>
  )
}

function Conversation({ id, onChanged }: { id: string; onChanged: () => Promise<void> }) {
  const toast = useToast()
  const [data, setData] = useState<{ ticket: Ticket; messages: TicketMessage[] } | null>(null)
  const [reply, setReply] = useState('')
  const load = useCallback(async () => { setData(await api.desk.get(await session.token(), id)) }, [id])
  useEffect(() => { void load() }, [load])
  if (!data) return <p className="muted small">Loading…</p>
  const closed = data.ticket.status === 'closed'
  return (
    <div className="thread">
      {data.messages.map((m, i) => (
        <div key={i} className={`bubble bubble-${m.from}`}>
          <span className="bubble-meta">{m.from === 'staff' ? m.author : 'You'} · {when(m.at)}</span>
          <p>{m.body}</p>
        </div>
      ))}
      {closed ? <p className="muted small">This request is closed. Open a new one if you need more help.</p> : (
        <form className="thread-reply" onSubmit={async (e) => {
          e.preventDefault()
          try { await api.desk.reply(await session.token(), id, reply.trim()); setReply(''); await load(); await onChanged() }
          catch (err) { toast(err instanceof Error ? err.message : 'Could not send.', 'error') }
        }}>
          <textarea aria-label="Reply" rows={2} maxLength={5000} placeholder="Write a reply" value={reply} onChange={(e) => setReply(e.target.value)} />
          <div className="settings-actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={async () => { await api.desk.close(await session.token(), id); await load(); await onChanged() }}>Close request</button>
            <button type="submit" className="btn btn-primary btn-sm" disabled={!reply.trim()}>Reply</button>
          </div>
        </form>
      )}
    </div>
  )
}
