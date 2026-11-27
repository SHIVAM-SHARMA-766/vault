// Confirming the master password before a sensitive admin action (admin
// console phase 3). The server asks (reauth_required); this asks the person,
// proves the password the way sign-in does, and the action goes again.

import { useEffect, useRef, useState } from 'react'

import { costOf, deriveLoginKeys, fromBase64Url } from '@vault/crypto'

import { ApiError, api, setReauthHandler } from '../../lib/api.js'
import * as session from '../../lib/session.js'
import { IconAlert, IconShield } from '../../ui/icons.js'
import { PasswordInput } from '../../ui/kit.js'

export function ReauthPrompt() {
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const settle = useRef<((ok: boolean) => void) | null>(null)

  useEffect(() => {
    setReauthHandler(() => new Promise<boolean>((resolve) => {
      settle.current?.(false)
      settle.current = resolve
      setPassword(''); setError(''); setOpen(true)
    }))
    return () => { setReauthHandler(null); settle.current?.(false) }
  }, [])

  const close = (ok: boolean) => { setOpen(false); setPassword(''); settle.current?.(ok); settle.current = null }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const state = session.get()
    if (!state) return close(false)
    setBusy(true); setError('')
    try {
      const keys = await deriveLoginKeys(password, fromBase64Url(state.kdf.salt), costOf(state.kdf))
      await api.reauth(await session.token(), keys.authKey)
      close(true)
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'invalid_credentials' ? 'That master password is not right.' : err instanceof Error ? err.message : 'Could not confirm it.')
    } finally { setBusy(false) }
  }

  if (!open) return null
  return (
    <div className="modal-backdrop reauth-backdrop" role="dialog" aria-modal="true" aria-labelledby="reauth-title">
      <form className="modal" onSubmit={(e) => void submit(e)}>
        <h2 id="reauth-title"><IconShield size={18} /> Confirm it is you</h2>
        <p className="muted">This changes who can do what on this server, so it asks for your master password again. It counts for ten minutes on this device.</p>
        <label htmlFor="reauth-password" className="field-label">Master password</label>
        <PasswordInput id="reauth-password" autoComplete="current-password" autoFocus required value={password} onChange={setPassword} />
        {error ? <p className="alert alert-error"><IconAlert size={16} />{error}</p> : null}
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={() => close(false)}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !password}>{busy ? <span className="spinner" /> : null}Confirm</button>
        </div>
      </form>
    </div>
  )
}
