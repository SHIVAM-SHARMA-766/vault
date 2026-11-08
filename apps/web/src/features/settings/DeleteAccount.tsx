// Settings → Account → Delete account. Irreversible, so it asks for the
// master password (and a two-factor code when that is on), a typed DELETE,
// and points at an export first. Organizations you own block it; the server
// says so in words.

import { useState } from 'react'

import { ApiError, api } from '../../lib/api.js'
import { Link, href } from '../../lib/router.js'
import * as session from '../../lib/session.js'
import { IconAlert, IconTrash } from '../../ui/icons.js'
import { PasswordInput } from '../../ui/kit.js'
import { proveCurrent } from './prove.js'

export function DeleteAccount({ state, twoFactor }: { state: session.Unlocked; twoFactor: boolean }) {
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      const currentAuthKey = await proveCurrent(state, password)
      await api.deleteAccount(await session.token(), { currentAuthKey, confirm: 'DELETE', ...(twoFactor ? { totpCode: code.replace(/\s+/g, '') } : {}) })
      session.lock()
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401
        ? twoFactor ? 'The master password or the two-factor code is wrong.' : 'The master password is wrong.'
        : err instanceof Error ? err.message : 'Could not delete the account.')
      setBusy(false)
    }
  }

  return (
    <section className="settings-card danger-zone" aria-labelledby="s-delete">
      <div className="settings-card-head"><IconTrash size={18} /><h2 id="s-delete">Delete account</h2></div>
      <p className="muted small">
        Deletes your account, your vault, its history, your backups kept on this server and your settings. It cannot be
        undone — nobody, including the people who run this server, can bring it back.
      </p>
      {!open ? (
        <div className="settings-actions"><button className="btn btn-danger-ghost" onClick={() => setOpen(true)}>Delete my account…</button></div>
      ) : (
        <form onSubmit={submit}>
          <p className="alert alert-warn"><IconAlert size={16} /><span>Want to keep your passwords? <Link to={href({ name: 'transfer' })}>Export them first</Link>.</span></p>
          <div className="field">
            <label htmlFor="del-pw">Master password</label>
            <PasswordInput id="del-pw" autoComplete="current-password" required value={password} onChange={setPassword} />
          </div>
          {twoFactor ? (
            <div className="field">
              <label htmlFor="del-code">Two-factor code</label>
              <input id="del-code" inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} />
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="del-confirm">Type DELETE to confirm</label>
            <input id="del-confirm" autoComplete="off" required value={typed} onChange={(e) => setTyped(e.target.value)} />
          </div>
          {error ? <p className="alert alert-error"><IconAlert size={16} /><span>{error}</span></p> : null}
          <div className="settings-actions">
            <button type="button" className="btn btn-secondary" onClick={() => { setOpen(false); setError(''); setPassword(''); setTyped(''); setCode('') }}>Cancel</button>
            <button type="submit" className="btn btn-danger" disabled={busy || typed !== 'DELETE' || !password}>
              {busy ? <><span className="spinner" />Deleting…</> : 'Delete my account permanently'}
            </button>
          </div>
        </form>
      )}
    </section>
  )
}
