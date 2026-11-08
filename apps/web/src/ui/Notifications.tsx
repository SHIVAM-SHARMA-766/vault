// The notification centre (E10): a bell in the top bar with what happened
// while you were away. The server sends ids and the labels it already holds;
// nothing here names an item, because the server cannot read item names.

import { useEffect, useRef, useState } from 'react'

import { type Note, api } from '../lib/api.js'
import { when } from '../lib/format.js'
import { navigate } from '../lib/router.js'
import * as session from '../lib/session.js'
import { IconBell } from './icons.js'

/** What a notification says, and where it leads. */
export function describeNote(n: Note): { text: string; to: string } {
  const d = n.data
  const who = typeof d['who'] === 'string' ? d['who'] : 'Someone'
  switch (n.kind) {
    case 'share-opened': return { text: `One of your share links was opened${d['ip'] ? ` from ${d['ip']}` : ''}${typeof d['viewsLeft'] === 'number' ? `; ${d['viewsLeft']} ${d['viewsLeft'] === 1 ? 'view' : 'views'} left` : ''}.`, to: '/app/settings/security' }
    case 'access-request': return { text: `${who} asked for access to a collection${d['reason'] ? `: “${d['reason']}”` : ''}.`, to: '/app/orgs' }
    case 'access-granted': return { text: `Your access request was approved${d['until'] ? `, until ${when(String(d['until']))}` : ''}.`, to: '/app/' }
    case 'access-denied': return { text: 'Your access request was turned down.', to: '/app/orgs' }
    case 'access-ended': return { text: 'A collection you checked out has closed again.', to: '/app/orgs' }
    case 'sensitive-opened': return { text: `${who} ${d['action'] === 'reveal' ? 'revealed a password in' : d['action'] === 'copy' ? 'copied from' : 'opened'} a sensitive item.`, to: '/app/orgs' }
    case 'org-invite': return { text: `You are invited to join ${d['hint'] || 'an organization'}.`, to: '/app/orgs' }
    case 'member-accepted': return { text: `${who} accepted your invitation. Confirm their fingerprint to share with them.`, to: '/app/orgs' }
    case 'backup-failed': return { text: `Your scheduled backup failed${d['error'] ? `: ${d['error']}` : ''}.`, to: '/app/settings/backups' }
    case 'emergency-request': return { text: 'Your trusted contact asked for emergency access.', to: '/app/settings/emergency' }
    default: return { text: 'Something happened.', to: '/app/' }
  }
}

export function NotificationBell() {
  const [open, setOpen] = useState(false)
  const [notes, setNotes] = useState<Note[]>([])
  const [unread, setUnread] = useState(0)
  const ref = useRef<HTMLDivElement>(null)

  const load = async () => {
    try { const r = await api.notifications(await session.token()); setNotes(r.notes); setUnread(r.unread) } catch { /* the bell stays quiet */ }
  }
  useEffect(() => {
    void load()
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load() }, 60_000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    if (!open) return
    void load()
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close) }
  }, [open])

  async function markAll() {
    try { const r = await api.readNotifications(await session.token(), 'all'); setNotes(r.notes); setUnread(r.unread) } catch { /* try again */ }
  }
  async function go(n: Note) {
    setOpen(false)
    if (!n.read) { try { const r = await api.readNotifications(await session.token(), [n.id]); setNotes(r.notes); setUnread(r.unread) } catch { /* fine */ } }
    navigate(describeNote(n).to)
  }

  return (
    <div className="menu" ref={ref}>
      <button className="icon-btn bell" aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'} aria-expanded={open} onClick={() => setOpen(!open)}>
        <IconBell size={18} />
        {unread ? <span className="bell-count" aria-hidden="true">{unread > 9 ? '9+' : unread}</span> : null}
      </button>
      {open ? (
        <div className="menu-pop notes-pop" role="dialog" aria-label="Notifications">
          <div className="notes-head">
            <strong>Notifications</strong>
            {unread ? <button className="link small" onClick={() => void markAll()}>Mark all read</button> : null}
          </div>
          {notes.length === 0 ? <p className="muted small notes-empty">Nothing yet. Sign-ins and account changes are under Settings → Security.</p> : (
            <ul className="notes-list">
              {notes.map((n) => {
                const { text } = describeNote(n)
                return (
                  <li key={n.id}>
                    <button className={`note ${n.read ? '' : 'is-unread'}`} onClick={() => void go(n)}>
                      <span>{text}</span>
                      <span className="muted small">{when(n.at)}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  )
}
