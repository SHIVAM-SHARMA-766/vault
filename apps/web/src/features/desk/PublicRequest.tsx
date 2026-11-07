// From the sign-in screen, with no account: ask to be let in, or ask for help
// signing in (usually a lost authenticator). Both become service desk tickets.

import { useState } from 'react'

import { ApiError, api } from '../../lib/api.js'
import { IconAlert, IconArrowLeft, IconCheck } from '../../ui/icons.js'

export function PublicRequest({ kind, onCancel }: { kind: 'access' | 'signin'; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [number, setNumber] = useState<number | null>(null)
  const access = kind === 'access'

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      setNumber((await api.desk.request({ kind, name: name.trim(), email: email.trim(), message: message.trim() })).number)
    } catch (err) {
      setError(err instanceof ApiError && err.status === 429 ? 'Too many requests from here. Try again later.' : err instanceof Error ? err.message : 'Could not send the request.')
    } finally {
      setBusy(false)
    }
  }

  if (number !== null) {
    return (
      <div>
        <h2 className="auth-title">Request sent</h2>
        <p className="alert alert-ok"><IconCheck size={16} />Your request number is #{number}.</p>
        <p className="auth-sub">
          {access
            ? 'Someone who runs this server will review it. If it is approved, you will receive an invitation by email.'
            : 'Someone who runs this server will contact you to confirm it is really you before changing anything on your account.'}
        </p>
        <button type="button" className="btn btn-secondary btn-block" onClick={onCancel}>Back to sign in</button>
      </div>
    )
  }

  return (
    <form onSubmit={submit}>
      <button type="button" className="back-link" onClick={onCancel}><IconArrowLeft size={16} />Back to sign in</button>
      <h2 className="auth-title">{access ? 'Request access' : 'Help signing in'}</h2>
      <p className="auth-sub">
        {access
          ? 'Accounts on this server are opened by invitation. Tell the people who run it who you are.'
          : 'Lost your phone or authenticator app, or locked out? The people who run this server can turn off two-factor sign-in after confirming it is you.'}
      </p>
      {!access ? (
        <p className="alert alert-warn"><IconAlert size={16} />Nobody can reset a forgotten master password — not even the server's owner. If that is the problem, use your recovery key instead.</p>
      ) : null}
      <div className="field">
        <label htmlFor="pr-name">Your name</label>
        <input id="pr-name" required maxLength={80} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="pr-email">{access ? 'Email' : 'The email you sign in with'}</label>
        <input id="pr-email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <p className="hint">Kept only until your request is closed, then erased.</p>
      </div>
      <div className="field">
        <label htmlFor="pr-message">{access ? 'Why do you need access? (optional)' : 'What happened? (optional)'}</label>
        <textarea id="pr-message" rows={3} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} />
        <p className="hint">Never write a password here.</p>
      </div>
      {error ? <p className="alert alert-error"><IconAlert size={16} />{error}</p> : null}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy || !name.trim() || !email.trim()}>
        {busy ? <><span className="spinner" />Sending…</> : 'Send request'}
      </button>
    </form>
  )
}
