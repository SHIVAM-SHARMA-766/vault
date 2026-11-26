// An account first, a vault later (decisions/0037):
//
//   AccountSignup   email → a 6-digit code by email → account password
//   VaultGate       signed in to an account with no vault: create one when the
//                   server is open or an administrator approved; otherwise ask
//                   for one, or use an invitation code
//   CreateVault     master password and recovery key, as at registration

import { useEffect, useState } from 'react'

import { belowMinimum } from '@vault/core'
import { createAccount, deriveAccountProof, deriveRecoveryProof, newAccountParams } from '@vault/crypto'

import { type AccountSession, saveAccount, signOutAccount } from '../../lib/account.js'
import { ApiError, type RegistrationMode, api } from '../../lib/api.js'
import { t } from '../../lib/i18n.js'
import { newIdentity } from '../../lib/identity.js'
import { useInstance } from '../../lib/instance.js'
import { newKdfCost } from '../../lib/kdf.js'
import * as session from '../../lib/session.js'
import { IconAlert, IconArrowLeft, IconCheck } from '../../ui/icons.js'
import { Check, CopyButton, PasswordInput, StrengthMeter } from '../../ui/kit.js'

const MIN_ACCOUNT = 10
const MIN_MASTER = 12

// ── Sign up ────────────────────────────────────────────────────────────────

export function AccountSignup() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [code, setCode] = useState('')
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function send(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    try { await api.account.signup(email); setSent(true) } catch (err) { setError(err instanceof Error ? err.message : 'Could not send the code.') } finally { setBusy(false) }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (pw.length < MIN_ACCOUNT) return setError(`The account password must be at least ${MIN_ACCOUNT} characters.`)
    if (pw !== confirm) return setError('The two passwords do not match.')
    setBusy(true)
    try {
      const params = newAccountParams()
      const r = await api.account.verify(email, code, { ...params, proof: await deriveAccountProof(pw, params) })
      saveAccount({ email: email.trim().toLowerCase(), accountToken: r.accountToken, kdf: null })
    } catch (err) {
      setError(err instanceof ApiError && err.status === 429 ? 'Too many attempts. Wait a few minutes.' : err instanceof Error ? err.message : 'Could not create the account.')
    } finally { setBusy(false) }
  }

  if (!sent) {
    return (
      <form onSubmit={(e) => void send(e)}>
        <h2 className="auth-title">{t('Create your account')}</h2>
        <p className="auth-sub">{t('Your email is your username. We send a code to it to check it is yours; your vault comes next.')}</p>
        <SocialSignup />
        <div className="field"><label htmlFor="su-email">{t('Email')}</label><input id="su-email" type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        {error ? <p className="alert alert-error"><IconAlert size={16} />{error}</p> : null}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy || !email}>{busy ? <span className="spinner" /> : null}{t('Send me a code')}</button>
      </form>
    )
  }
  return (
    <form onSubmit={(e) => void create(e)}>
      <button type="button" className="back-link" onClick={() => { setSent(false); setCode('') }}><IconArrowLeft size={16} />{t('Use another address')}</button>
      <h2 className="auth-title">{t('Check your email')}</h2>
      <p className="auth-sub">We sent a 6-digit code to <strong>{email}</strong>. It works for 10 minutes. (Already have an account with this address? The email says so instead.)</p>
      <div className="field"><label htmlFor="su-code">{t('Code')}</label><input id="su-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></div>
      <div className="field"><label htmlFor="su-pw">{t('Account password')}</label><PasswordInput id="su-pw" autoComplete="new-password" required value={pw} onChange={setPw} />
        <p className="hint">Step one of every sign-in. Your vault will get a different master password.</p></div>
      <div className="field"><label htmlFor="su-confirm">{t('Confirm account password')}</label><PasswordInput id="su-confirm" autoComplete="new-password" required value={confirm} onChange={setConfirm} /></div>
      {error ? <p className="alert alert-error"><IconAlert size={16} />{error}</p> : null}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy || code.length !== 6 || !pw}>{busy ? <span className="spinner" /> : null}{t('Create my account')}</button>
    </form>
  )
}

/** Signing up with Google or Microsoft: shown, not offered yet. */
function SocialSignup() {
  return (
    <>
      <div className="social-signup">
        <button type="button" className="btn btn-secondary btn-block social-btn" disabled aria-describedby="social-soon">
          <GoogleMark />{t('Continue with Google')}<span className="soon">{t('Coming soon')}</span>
        </button>
        <button type="button" className="btn btn-secondary btn-block social-btn" disabled aria-describedby="social-soon">
          <MicrosoftMark />{t('Continue with Microsoft')}<span className="soon">{t('Coming soon')}</span>
        </button>
        <p id="social-soon" className="visually-hidden">{t('Not available yet. Use your email below.')}</p>
      </div>
      <div className="auth-or"><span>{t('or with your email')}</span></div>
    </>
  )
}

const GoogleMark = () => (
  <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z" />
    <path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z" />
    <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.2 0-11.5-4.1-13.4-9.8l-7.9 6.1C6.6 42.6 14.6 48 24 48z" />
  </svg>
)

const MicrosoftMark = () => (
  <svg width="16" height="16" viewBox="0 0 22 22" aria-hidden="true">
    <rect x="1" y="1" width="9" height="9" fill="#F25022" /><rect x="12" y="1" width="9" height="9" fill="#7FBA00" />
    <rect x="1" y="12" width="9" height="9" fill="#00A4EF" /><rect x="12" y="12" width="9" height="9" fill="#FFB900" />
  </svg>
)

// ── Signed in, no vault ────────────────────────────────────────────────────

export function VaultGate({ account }: { account: AccountSession }) {
  const [status, setStatus] = useState<{ approved: boolean; requested: boolean; registration: RegistrationMode } | null>(null)
  const [mode, setMode] = useState<'gate' | 'create' | 'code'>('gate')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    void api.account.vaultStatus(account.accountToken).then(setStatus).catch((err: unknown) => {
      // It has a vault after all (made on another device): unlock instead.
      if (err instanceof ApiError && err.status === 409) void api.account.session(account.accountToken).then((r) => { if (r.kdf) saveAccount({ ...account, kdf: r.kdf }) })
      else setError(err instanceof Error ? err.message : 'Could not check your account.')
    })
  }, [account])

  const head = <p className="auth-sub account-line">{t('Signed in as')} <strong>{account.email}</strong> · <button type="button" className="link" onClick={() => void signOutAccount()}>{t('Not you? Sign out')}</button></p>
  if (!status) return <div>{head}{error ? <p className="alert alert-error"><IconAlert size={16} />{error}</p> : <p className="muted small">Loading…</p>}</div>
  const canCreate = status.approved || status.registration === 'open'
  if (mode === 'create' || mode === 'code' || (canCreate && mode === 'gate')) {
    return <CreateVault account={account} withCode={mode === 'code'} onBack={canCreate ? undefined : () => setMode('gate')} head={head} approved={status.approved} />
  }

  async function ask(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    try { await api.account.requestVault(account.accountToken, note); setStatus({ ...status!, requested: true }) } catch (err) { setError(err instanceof Error ? err.message : 'Could not send the request.') } finally { setBusy(false) }
  }

  return (
    <div>
      <span className="step">{t('Your account is ready')}</span>
      <h2 className="auth-title">{t('Ask for a vault')}</h2>
      {head}
      {status.requested ? (
        <p className="alert alert-ok"><IconCheck size={16} /><span>Your request was sent. When it is approved you get an email, and signing in here lets you create your vault.</span></p>
      ) : (
        <form onSubmit={(e) => void ask(e)}>
          <p className="auth-sub">This server gives vaults by invitation. Send a request to the people who run it; they approve it from their admin console.</p>
          <div className="field"><label htmlFor="vr-note">{t('A note for them (optional)')}</label><textarea id="vr-note" rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Asha from finance" /></div>
          {error ? <p className="alert alert-error"><IconAlert size={16} />{error}</p> : null}
          <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{busy ? <span className="spinner" /> : null}{t('Send a request for a vault')}</button>
        </form>
      )}
      <p className="auth-forgot"><button type="button" className="link" onClick={() => setMode('code')}>{t('I have an invitation code')}</button></p>
    </div>
  )
}

// ── Creating the vault ─────────────────────────────────────────────────────

function CreateVault({ account, withCode, onBack, head, approved }: { account: AccountSession; withCode: boolean; onBack: (() => void) | undefined; head: React.ReactNode; approved: boolean }) {
  const instance = useInstance()
  const [code, setCode] = useState('')
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<{ recoveryKey: string; open: () => void } | null>(null)
  const [ack, setAck] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (pw.length < MIN_MASTER) return setError(`The master password must be at least ${MIN_MASTER} characters.`)
    const weak = belowMinimum(pw, instance?.minPasswordScore ?? 0)
    if (weak) return setError(weak)
    if (pw !== confirm) return setError('The two passwords do not match.')
    setBusy(true)
    try {
      const created = await createAccount(pw, await newKdfCost())
      const result = await api.register({
        email: account.email, authKey: created.authKey, recoveryAuthKey: await deriveRecoveryProof(created.recoveryKey), kdf: created.kdf,
        wrappedVaultKey: created.wrappedVaultKey, wrappedVaultKeyForRecovery: created.wrappedVaultKeyForRecovery,
        identity: await newIdentity(created.vaultKey), accountToken: account.accountToken, ...(withCode && code.trim() ? { inviteCode: code.trim() } : {}),
      })
      // The account sign-in is updated only once the recovery key is saved:
      // updating it now would move this screen on before the key is shown.
      setDone({
        recoveryKey: created.recoveryKey,
        open: () => {
          if (result.accountToken) saveAccount({ email: account.email, accountToken: result.accountToken, kdf: created.kdf })
          session.unlock({ userId: result.userId, email: account.email, vaultKey: created.vaultKey, accessToken: result.accessToken, refreshToken: result.refreshToken, kdf: created.kdf, accessExpiresAt: session.expiresAtFrom(result) })
        },
      })
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403 ? (withCode ? 'That invitation code is not valid.' : 'This server does not let you create a vault yet.') : err instanceof Error ? err.message : 'Could not create the vault.')
    } finally { setBusy(false) }
  }

  if (done) {
    return (
      <div>
        <h2 className="auth-title">{t('Save your recovery key')}</h2>
        <p className="auth-sub">The only way back into your vault if you forget the master password. It is shown once, it was never sent to the server, and nobody can reissue it.</p>
        <div className="recovery-key"><code>{done.recoveryKey}</code><CopyButton value={done.recoveryKey} label="Recovery key" /></div>
        <Check checked={ack} onChange={setAck}>I have stored the recovery key somewhere safe, off this device.</Check>
        <button type="button" className="btn btn-primary btn-block" disabled={!ack} onClick={done.open}>{t('Open my vault')}</button>
      </div>
    )
  }
  return (
    <form onSubmit={(e) => void submit(e)}>
      {onBack ? <button type="button" className="back-link" onClick={onBack}><IconArrowLeft size={16} />{t('Back')}</button> : null}
      <span className="step">{t('Step 2 of 2')}</span>
      <h2 className="auth-title">{t('Create your vault')}</h2>
      {head}
      {approved ? <p className="alert alert-ok"><IconCheck size={16} /><span>Your request was approved.</span></p> : null}
      <p className="auth-sub">Choose a master password. It opens your vault in this browser, it is different from your account password, and nobody can reset it.</p>
      {withCode ? <div className="field"><label htmlFor="cv-code">{t('Invitation code')}</label><input id="cv-code" className="mono" required autoComplete="off" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} /></div> : null}
      <div className="field"><label htmlFor="cv-pw">{t('Master password')}</label><PasswordInput id="cv-pw" autoComplete="new-password" required autoFocus value={pw} onChange={setPw} /><StrengthMeter password={pw} /></div>
      <div className="field"><label htmlFor="cv-confirm">{t('Confirm master password')}</label><PasswordInput id="cv-confirm" autoComplete="new-password" required value={confirm} onChange={setConfirm} /></div>
      {error ? <p className="alert alert-error"><IconAlert size={16} />{error}</p> : null}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy || !pw}>{busy ? <><span className="spinner" />{t('Creating…')}</> : t('Create my vault')}</button>
    </form>
  )
}
