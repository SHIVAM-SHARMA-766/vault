// The second step of signing in, when the account has two-factor sign-in on:
// a six-digit code from the authenticator app, or one of the recovery codes.

import { useState } from 'react'

import type { SecondFactor as Factor, SecondFactorOffer } from '../lib/api.js'
import { getAssertion, webauthnSupported } from '../lib/webauthn.js'
import { IconAlert, IconKey } from './icons.js'

export function SecondFactorStep({ onSubmit, onCancel, busy, error, offer }: {
  onSubmit: (factor: Factor) => void
  onCancel: () => void
  busy: boolean
  error: string
  /** What the server offered; without it, code or recovery code. */
  offer?: SecondFactorOffer | null
}) {
  const hasKey = !!offer?.webauthn && webauthnSupported()
  const hasTotp = !offer || offer.methods.includes('totp')
  const [mode, setMode] = useState<'key' | 'code' | 'recovery'>(hasKey ? 'key' : 'code')
  const useRecovery = mode === 'recovery'
  const setUseRecovery = (v: boolean) => setMode(v ? 'recovery' : hasTotp ? 'code' : 'key')
  const [value, setValue] = useState('')
  const [keyError, setKeyError] = useState('')

  if (mode === 'key' && offer?.webauthn) {
    return (
      <div>
        <span className="step">Two-factor sign-in</span>
        <h2 className="auth-title">Use your passkey or security key</h2>
        <p className="auth-sub">Touch your security key, or confirm with this device&apos;s passkey, when your browser asks.</p>
        {error || keyError ? <p className="alert alert-error"><IconAlert size={16} />{error || keyError}</p> : null}
        <button type="button" className="btn btn-primary btn-block" disabled={busy} onClick={async () => {
          setKeyError('')
          try { onSubmit({ webauthn: await getAssertion(offer.webauthn!) }) }
          catch { setKeyError('The key did not answer. Try again, or use another way below.') }
        }}>{busy ? <><span className="spinner" />Checking…</> : <><IconKey size={16} />Use my key</>}</button>
        <p className="auth-switch">
          {hasTotp ? <><button type="button" className="link" onClick={() => { setMode('code'); setValue('') }}>Use the authenticator app</button>{' · '}</> : null}
          <button type="button" className="link" onClick={() => { setMode('recovery'); setValue('') }}>Use a recovery code</button>
          {' · '}
          <button type="button" className="link" onClick={onCancel}>Cancel</button>
        </p>
      </div>
    )
  }
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
          {useRecovery ? (hasTotp ? 'Use the authenticator app instead' : 'Use my key instead') : 'Lost your phone? Use a recovery code'}
        </button>
        {hasKey && mode === 'code' ? <>{' · '}<button type="button" className="link" onClick={() => setMode('key')}>Use my key</button></> : null}
        {' · '}
        <button type="button" className="link" onClick={onCancel}>Cancel</button>
      </p>
    </form>
  )
}
