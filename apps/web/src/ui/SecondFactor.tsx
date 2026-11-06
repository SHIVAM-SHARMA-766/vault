// The second step of signing in, when the account has two-factor sign-in on:
// a six-digit code from the authenticator app, or one of the recovery codes.

import { useState } from 'react'

import type { SecondFactor as Factor } from '../lib/api.js'
import { IconAlert } from './icons.js'

export function SecondFactorStep({ onSubmit, onCancel, busy, error }: {
  onSubmit: (factor: Factor) => void
  onCancel: () => void
  busy: boolean
  error: string
}) {
  const [useRecovery, setUseRecovery] = useState(false)
  const [value, setValue] = useState('')
  const ready = useRecovery ? value.replace(/[^0-9a-z]/gi, '').length >= 10 : /^\d{6}$/.test(value.replace(/\s/g, ''))

  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(useRecovery ? { recoveryCode: value.trim() } : { totpCode: value.replace(/\s/g, '') }) }}>
      <span className="step">Two-factor sign-in</span>
      <h2 className="auth-title">{useRecovery ? 'Enter a recovery code' : 'Enter your code'}</h2>
      <p className="auth-sub">
        {useRecovery
          ? 'One of the codes you saved when you turned on two-factor sign-in. Each works once.'
          : 'Open your authenticator app and enter the six-digit code for Vault.'}
      </p>
      <div className="field">
        <label htmlFor="tf-code">{useRecovery ? 'Recovery code' : 'Six-digit code'}</label>
        <input id="tf-code" autoFocus autoComplete="one-time-code" spellCheck={false}
               inputMode={useRecovery ? 'text' : 'numeric'} className={useRecovery ? 'mono' : 'code-input'}
               placeholder={useRecovery ? 'XXXXX-XXXXX' : '123 456'} maxLength={useRecovery ? 16 : 7}
               value={value} onChange={(e) => setValue(e.target.value)} />
      </div>
      {error ? <p className="alert alert-error"><IconAlert size={16} />{error}</p> : null}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy || !ready}>
        {busy ? <><span className="spinner" />Checking…</> : 'Continue'}
      </button>
      <p className="auth-switch">
        <button type="button" className="link" onClick={() => { setUseRecovery(!useRecovery); setValue('') }}>
          {useRecovery ? 'Use the authenticator app instead' : 'Lost your phone? Use a recovery code'}
        </button>
        {' · '}
        <button type="button" className="link" onClick={onCancel}>Cancel</button>
      </p>
    </form>
  )
}
