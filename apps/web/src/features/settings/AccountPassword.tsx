// The account password (decisions/0036): the first step of signing in. Changing
// it needs the current one, and signs every other device out of the account.

import { useEffect, useState } from 'react'

import { deriveAccountProof } from '@vault/crypto'

import { accountPasswordPayload, saveAccount } from '../../lib/account.js'
import { ApiError, api } from '../../lib/api.js'
import { when } from '../../lib/format.js'
import * as session from '../../lib/session.js'
import { IconAlert, IconUser } from '../../ui/icons.js'
import { PasswordInput, useToast } from '../../ui/kit.js'

export function AccountPassword({ state, status, reload }: { state: session.Unlocked; status: { set: boolean; setAt?: string } | null; reload: () => void }) {
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { if (!open) { setCurrent(''); setNext(''); setConfirm(''); setError('') } }, [open])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (next.length < 10) return setError('At least 10 characters.')
    if (next !== confirm) return setError('The two new passwords do not match.')
    setBusy(true)
    try {
      const payload = await accountPasswordPayload(next, state.kdf)
      let currentAccountProof: string | undefined
      if (status?.set) {
        const { account } = await api.account.prelogin(state.email)
        currentAccountProof = await deriveAccountProof(current, account)
      }
      const r = await api.account.setPassword(await session.token(), { ...payload, ...(currentAccountProof ? { currentAccountProof } : {}) })
      saveAccount({ email: state.email, accountToken: r.accountToken, kdf: state.kdf })
      toast(status?.set ? 'Account password changed. Other devices sign in again.' : 'Account password set')
      setOpen(false); reload()
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'invalid_credentials' ? 'The current account password is wrong.'
        : err instanceof Error ? err.message : 'Could not save it.')
    } finally { setBusy(false) }
  }

  return (
    <section className="settings-card" aria-labelledby="s-account-pw">
      <div className="settings-card-head"><IconUser size={18} /><h2 id="s-account-pw">Account password</h2>
        {status ? <span className={`pill ${status.set ? 'pill-ok' : 'pill-warn'}`}>{status.set ? 'Set' : 'Not set'}</span> : null}</div>
      <p className="muted small">The first step of signing in, with your email and two-factor. Then your master password opens the vault. It can be reset by email; your master password cannot.{status?.setAt ? ` Last changed ${when(status.setAt)}.` : ''}</p>
      {open ? (
        <form onSubmit={(e) => void submit(e)}>
          {status?.set ? <div className="field"><label htmlFor="ap-current">Current account password</label><PasswordInput id="ap-current" autoComplete="current-password" required value={current} onChange={setCurrent} /></div> : null}
          <div className="grid-2">
            <div className="field"><label htmlFor="ap-new">New account password</label><PasswordInput id="ap-new" autoComplete="new-password" required value={next} onChange={setNext} /></div>
            <div className="field"><label htmlFor="ap-confirm">Confirm it</label><PasswordInput id="ap-confirm" autoComplete="new-password" required value={confirm} onChange={setConfirm} /></div>
          </div>
          {error ? <p className="alert alert-error"><IconAlert size={16} />{error}</p> : null}
          <div className="settings-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy || !next}>{busy ? <span className="spinner" /> : null}{status?.set ? 'Change it' : 'Set it'}</button>
          </div>
        </form>
      ) : <div className="settings-actions"><button className="btn btn-secondary" disabled={!status} onClick={() => setOpen(true)}>{status?.set ? 'Change account password' : 'Set an account password'}</button></div>}
    </section>
  )
}
