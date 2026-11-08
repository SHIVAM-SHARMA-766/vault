// Signed-in devices and recent security activity. A device is one browser
// that signed in; it keeps its row across token refreshes. Signing one out
// stops it within fifteen minutes at most (its current access token's life).

import { useEffect, useState } from 'react'

import { type DeviceSession, api } from '../../lib/api.js'
import * as session from '../../lib/session.js'
import { IconClock, IconEdit, IconLock } from '../../ui/icons.js'
import { useToast } from '../../ui/kit.js'
import { when } from '../../lib/format.js'


export function Devices() {
  const toast = useToast()
  const [rows, setRows] = useState<DeviceSession[] | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null)
  const [confirmAll, setConfirmAll] = useState(false)

  async function load() {
    try { setRows((await api.sessions(await session.token())).sessions); setError('') }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not load devices.') }
  }
  useEffect(() => { void load() }, [])

  async function rename(id: string, name: string) {
    try { await api.renameSession(await session.token(), id, name); setEditing(null); await load() }
    catch (err) { toast(err instanceof Error ? err.message : 'Could not rename.', 'error') }
  }

  async function revoke(row: DeviceSession) {
    try {
      await api.revokeSession(await session.token(), row.id)
      if (row.current) { session.lock(); return }
      toast(`${row.name || row.device} signed out`)
      await load()
    } catch (err) { toast(err instanceof Error ? err.message : 'Could not sign it out.', 'error') }
  }

  return (
    <section className="settings-card" aria-labelledby="s-sessions">
      <div className="settings-card-head"><IconLock size={18} /><h2 id="s-sessions">Signed-in devices</h2></div>
      <p className="muted small">Every browser signed in to this account. Sign out any you do not recognise, then change your master password.</p>
      {error ? <p className="muted small">{error}</p> : rows === null ? <p className="muted small">Loading…</p> : (
        <ul className="device-list">
          {rows.map((r) => (
            <li key={r.id} className="device-row">
              <div className="device-text">
                {editing?.id === r.id ? (
                  <form className="device-rename" onSubmit={(e) => { e.preventDefault(); void rename(r.id, editing.name) }}>
                    <input aria-label="Device name" autoFocus maxLength={40} placeholder={r.device} value={editing.name}
                           onChange={(e) => setEditing({ id: r.id, name: e.target.value })} />
                    <button className="btn btn-primary btn-sm" type="submit">Save</button>
                    <button className="btn btn-secondary btn-sm" type="button" onClick={() => setEditing(null)}>Cancel</button>
                  </form>
                ) : (
                  <span className="device-name">
                    {r.name || r.device}
                    {r.current ? <span className="pill pill-accent">This device</span> : null}
                  </span>
                )}
                <span className="muted small">
                  {r.name ? `${r.device} · ` : ''}{r.ip || 'unknown address'} · signed in {when(r.createdAt)} · last active {when(r.lastUsedAt)}
                </span>
              </div>
              {editing?.id === r.id ? null : (
                <div className="device-actions">
                  <button className="icon-btn" aria-label={`Rename ${r.name || r.device}`} title="Rename" onClick={() => setEditing({ id: r.id, name: r.name ?? '' })}><IconEdit size={15} /></button>
                  <button className="btn btn-danger-ghost btn-sm" onClick={() => void revoke(r)}>{r.current ? 'Sign out' : 'Sign out device'}</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {confirmAll ? (
        <div className="confirm">
          <p><strong>Sign out everywhere?</strong> You will need your master password on every device, including this one.</p>
          <div className="confirm-actions">
            <button className="btn btn-secondary btn-sm" onClick={() => setConfirmAll(false)}>Cancel</button>
            <button className="btn btn-danger btn-sm" onClick={async () => {
              try { await api.logoutEverywhere(await session.token()); session.lock() }
              catch (err) { toast(err instanceof Error ? err.message : 'Could not sign out.', 'error') }
            }}>Sign out everywhere</button>
          </div>
        </div>
      ) : (
        <div className="settings-actions">
          <button className="btn btn-danger-ghost" onClick={() => setConfirmAll(true)}>Sign out everywhere</button>
        </div>
      )}
    </section>
  )
}

const KIND: Record<string, string> = {
  'register': 'Account created',
  'login': 'Signed in',
  'recovery-login': 'Signed in with the recovery key',
  'change-password': 'Master password changed',
  'reset-password-with-recovery-key': 'Master password reset with the recovery key',
  'rotate-recovery-key': 'Recovery key replaced',
  'enrol-identity': 'Identity key created',
  'enable-2fa': 'Two-factor sign-in turned on',
  'disable-2fa': 'Two-factor sign-in turned off',
  'regenerate-2fa-recovery-codes': 'New two-factor recovery codes',
  'used-2fa-recovery-code': 'A two-factor recovery code was used',
  'revoke-session': 'A device was signed out',
  'share-create': 'A share link was made',
  'share-open': 'One of your share links was opened',
  'emergency-request': 'Emergency access was requested',
  'emergency-access': 'Emergency access was used',
}

export function Activity() {
  const [events, setEvents] = useState<{ kind: string; at: string; ip: string; device: string }[] | null>(null)
  const [all, setAll] = useState(false)
  useEffect(() => {
    void (async () => {
      try { setEvents((await api.activity(await session.token())).events) } catch { setEvents([]) }
    })()
  }, [])
  const shown = all ? events ?? [] : (events ?? []).slice(0, 8)
  return (
    <section className="settings-card" aria-labelledby="s-activity">
      <div className="settings-card-head"><IconClock size={18} /><h2 id="s-activity">Security activity</h2></div>
      <p className="muted small">Sign-ins and account changes from the last ninety days. The server records when and from where, never what is in your vault.</p>
      {events === null ? <p className="muted small">Loading…</p> : events.length === 0 ? <p className="muted small">Nothing recorded yet.</p> : (
        <ul className="activity-list">
          {shown.map((e, i) => (
            <li key={`${e.at}-${i}`}>
              <span>{KIND[e.kind] ?? e.kind}</span>
              <span className="muted small">{when(e.at)} · {e.device} · {e.ip || 'unknown address'}</span>
            </li>
          ))}
        </ul>
      )}
      {events && events.length > 8 && !all ? (
        <div className="settings-actions settings-actions-left"><button className="btn btn-secondary btn-sm" onClick={() => setAll(true)}>Show all {events.length}</button></div>
      ) : null}
    </section>
  )
}
