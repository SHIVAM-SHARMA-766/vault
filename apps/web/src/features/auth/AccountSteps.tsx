// Signing in in two steps (decisions/0036):
//
//   AccountSignIn   email + account password (+ two-factor, or single sign-on):
//                   this browser keeps the account sign-in
//   MasterUnlock    the master password: proves itself to the server with the
//                   account sign-in, gets the wrapped vault key, opens it here
//
// plus choosing an account password (first time, from the old master-password
// sign-in), and resetting a forgotten one by email.

import { useEffect, useState } from 'react'

import { passwordStrength } from '@vault/core'
import {
  SecretKeyFormatError, UnsealError, costOf, deriveAccountProof, deriveLoginKeys, fromBase64Url, kdfProblem, newAccountParams,
  parseSecretKey, unwrapVaultKey, wipe,
} from '@vault/crypto'

import { type AccountSession, accountPasswordPayload, currentAccount, forgetAccount, saveAccount, signOutAccount } from '../../lib/account.js'
import { ApiError, type KdfParams, type SecondFactor, type SecondFactorOffer, api } from '../../lib/api.js'
import { t } from '../../lib/i18n.js'
import { useInstance } from '../../lib/instance.js'
import { NoPrfError, passkeysOffered, signInWithPasskey } from '../../lib/passkey.js'
import { forgetSecretKey, loadSecretKey, storeSecretKey } from '../../lib/secretkey.js'
import * as session from '../../lib/session.js'
import { IconAlert, IconArrowLeft, IconFingerprint } from '../../ui/icons.js'
import { PasswordInput } from '../../ui/kit.js'
import { SecondFactorStep } from '../../ui/SecondFactor.js'

const MIN_ACCOUNT = 10

function rateLimited(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.status !== 429) return null
  const wait = err.retryAfter ? Math.ceil(err.retryAfter / 60) : null
  return wait ? `Too many attempts. Try again in ${wait} minute(s).` : err.message
}

function PasskeyButton({ busy, onError, ssoTicket }: { busy: boolean; onError: (m: string) => void; ssoTicket?: string }) {
  const [offered, setOffered] = useState(false)
  useEffect(() => { void passkeysOffered().then(setOffered) }, [])
  if (!offered) return null
  return (
    <>
      <div className="auth-or"><span>{t('or')}</span></div>
      <button type="button" className="btn btn-secondary btn-block" disabled={busy} onClick={() => {
        signInWithPasskey(ssoTicket).catch((err: unknown) => onError(
          err instanceof NoPrfError ? err.message
            : err instanceof DOMException ? 'No passkey was used. If you have not added one, sign in and add it in Settings → Security.'
            : err instanceof ApiError ? err.message : 'The passkey did not open the vault.'))
      }}><IconFingerprint size={16} />{t('Sign in with a passkey')}</button>
    </>
  )
}

// ── Step 1: the account ────────────────────────────────────────────────────

export function AccountSignIn({ forAdmin, sso, ssoError, onSsoCancel, onLegacy, onForgot, onRegister, onRecover, onRequestAccess, onSigninHelp }: {
  forAdmin: boolean; sso: { ticket: string; email: string } | null; ssoError: string; onSsoCancel?: () => void
  onLegacy: () => void; onForgot: () => void; onRegister: () => void; onRecover: () => void; onRequestAccess: () => void; onSigninHelp: () => void
}) {
  const instance = useInstance()
  const mode = instance?.registration
  const deskOn = instance?.features?.serviceDesk ?? true
  const ssoOffer = instance?.sso ?? null
  const [ownerPath, setOwnerPath] = useState(false)
  const ssoOnly = !!ssoOffer?.required && !sso && !ownerPath
  const [email, setEmail] = useState(sso?.email ?? '')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(ssoError)
  const [pending, setPending] = useState<{ proof?: string } | null>(null)
  const [offer, setOffer] = useState<SecondFactorOffer | null>(null)

  async function attempt(proof: string | undefined, second?: SecondFactor) {
    // No proof: single sign-on did the account step; the server reads the ticket.
    // The ticket names the address (it can arrive after this screen opened).
    const who = sso?.email ?? email
    const r = await api.account.login(who, proof, second, sso?.ticket)
    saveAccount({ email: who, accountToken: r.accountToken, kdf: r.kdf })
  }

  function explain(err: unknown) {
    const limited = rateLimited(err)
    if (limited) setError(limited)
    else if (err instanceof ApiError && err.status === 401 && err.code === 'invalid_credentials') setError('Wrong email or account password. Signing in for the first time since accounts were added? Use your master password once, below.')
    else if (err instanceof ApiError && err.status === 403 && err.code === 'forbidden') setError('This account has been disabled. Contact the person who runs this vault.')
    else setError(err instanceof Error ? err.message : 'Something went wrong.')
  }

  async function login(proof: string | undefined) {
    try { await attempt(proof) } catch (err) {
      if (err instanceof ApiError && err.code === 'two_factor_required') { setPending(proof ? { proof } : {}); setOffer((err.details as SecondFactorOffer | undefined) ?? null); return }
      throw err
    }
  }

  // Back from the identity provider: the ticket is the account step.
  useEffect(() => {
    if (!sso) return
    setBusy(true)
    void login(undefined).catch(explain).finally(() => setBusy(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sso?.ticket])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(''); setBusy(true)
    try {
      const { account } = await api.account.prelogin(email)
      await login(await deriveAccountProof(password, account))
    } catch (err) { explain(err) } finally { setBusy(false) }
  }

  async function submitSecond(second: SecondFactor) {
    if (!pending) return
    setError(''); setBusy(true)
    try { await attempt(pending.proof, second); setPending(null) } catch (err) {
      explain(err)
      if ('webauthn' in second) {
        try { await attempt(pending.proof) } catch (again) {
          if (again instanceof ApiError && again.code === 'two_factor_required') setOffer((again.details as SecondFactorOffer | undefined) ?? null)
        }
      }
    } finally { setBusy(false) }
  }

  if (pending) return <SecondFactorStep onSubmit={submitSecond} onCancel={() => { setPending(null); setError('') }} busy={busy} error={error} offer={offer} />

  return (
    <form onSubmit={(e) => void submit(e)}>
      <span className="step">{t('Step 1 of 2')}</span>
      <h2 className="auth-title">{forAdmin ? 'Sign in to the admin console' : t('Sign in to your account')}</h2>
      <p className="auth-sub">{t('Your email and account password, then your master password opens the vault in this browser.')}</p>

      {error ? <p className="alert alert-error"><IconAlert size={16} />{error}</p> : null}
      {sso ? (
        <p className="alert alert-info sso-banner"><span>{ssoOffer?.name ?? 'Your identity provider'} signed you in as <strong>{sso.email}</strong>{busy ? '…' : '.'}{' '}
          <button type="button" className="link" onClick={onSsoCancel}>Not you?</button></span></p>
      ) : ssoOffer ? (
        <>
          <a className={`btn ${ssoOffer.required ? 'btn-primary' : 'btn-secondary'} btn-block sso-start`} href="/api/auth/sso/start">{t('Sign in with')} {ssoOffer.name}</a>
          {ssoOnly ? (
            <p className="hint sso-owner"><button type="button" className="link" onClick={() => setOwnerPath(true)}>Server owner? Sign in with your account password</button></p>
          ) : <div className="auth-or"><span>{t('or')}</span></div>}
        </>
      ) : null}

      {ssoOnly || sso ? null : <>
        <div className="field">
          <label htmlFor="email">{t('Email')}</label>
          <input id="email" type="email" autoComplete="username" required autoFocus={!ssoOffer} placeholder="you@example.com"
                 value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="account-password">{t('Account password')}</label>
          <PasswordInput id="account-password" autoComplete="current-password" required value={password} onChange={setPassword} />
        </div>
        <button type="submit" className="btn btn-primary btn-block" disabled={busy || !email || !password}>
          {busy ? <><span className="spinner" />{t('Signing in…')}</> : t('Continue')}
        </button>
        <PasskeyButton busy={busy} onError={setError} />
      </>}

      <p className="auth-forgot">
        <button type="button" className="link" onClick={onForgot}>{t('Forgot your account password?')}</button><br />
        <button type="button" className="link" onClick={onLegacy}>{t('First sign-in since accounts were added? Use your master password')}</button><br />
        <button type="button" className="link" onClick={onRecover}>{t('Forgot your master password? Use your recovery key')}</button>
        {deskOn ? <><br /><button type="button" className="link" onClick={onSigninHelp}>{t('Lost your authenticator, or can\'t sign in? Ask for help')}</button></> : null}
      </p>
      <p className="auth-switch">
        {mode === 'open' ? <>New here? <button type="button" className="link" onClick={onRegister}>{t('Create an account')}</button></>
          : mode === 'closed' && instance?.firstRun ? <>New server? <button type="button" className="link" onClick={onRegister}>Create the owner account</button> with the setup code from its log</>
          : mode === 'closed' ? (deskOn ? <>New here? <button type="button" className="link" onClick={onRequestAccess}>{t('Request access')}</button></> : null)
          : <>{mode === 'invite' ? 'Have an invitation?' : 'New here?'} <button type="button" className="link" onClick={onRegister}>{t('Create an account')}</button>
            {' · '}<button type="button" className="link" onClick={onRequestAccess}>{t('Request access')}</button></>}
      </p>
    </form>
  )
}

// ── Step 2: the master password ────────────────────────────────────────────

export function MasterUnlock({ account, forAdmin, onRecover }: { account: AccountSession; forAdmin: boolean; onRecover: () => void }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [kdf, setKdf] = useState<KdfParams>(account.kdf)
  const [needKey, setNeedKey] = useState(false)
  const [secretText, setSecretText] = useState('')
  const [heldButRefused, setHeldButRefused] = useState(false)
  // Unlock waits for this check, so the settings it uses are current (a secret
  // key removed, or a new master password, on another device).
  const [checked, setChecked] = useState(false)

  // Still signed in to the account? And the master password's current settings
  // (it may have changed on another device). The token is replaced each time.
  useEffect(() => {
    let live = true
    void api.account.session(account.accountToken).then((r) => {
      if (!live) return
      setKdf(r.kdf)
      setChecked(true)
    }).catch((err: unknown) => {
      if (!live) return
      // Ended, unless another tab has since replaced the token.
      if (err instanceof ApiError && err.status === 401) { if (currentAccount()?.accountToken === account.accountToken) forgetAccount() }
      else setChecked(true)
    })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(''); setBusy(true)
    let kek: Uint8Array | null = null
    try {
      const email = account.email
      const typedEarly = needKey && secretText.trim() ? await parseSecretKey(secretText) : undefined
      const held = await loadSecretKey(email)
      if (held && kdf.version !== 2) {
        held.fill(0); setHeldButRefused(true)
        setError('This browser holds a secret key for this account, but the server says the account has none. If you removed it on another device, forget it here; otherwise do not continue.')
        return
      }
      let secretKey: Uint8Array | undefined = held ?? undefined
      let typedKey: Uint8Array | undefined
      if (kdf.version === 2 && !secretKey) {
        if (!needKey || !secretText.trim()) { setNeedKey(true); setError('This account uses a secret key. Enter it from your Emergency Kit; this browser keeps it after that.'); return }
        secretKey = typedKey = typedEarly ?? await parseSecretKey(secretText)
      } else typedEarly?.fill(0)
      if (kdfProblem(kdf)) throw new Error('The server sent key settings Vault does not use, so nothing was derived.')
      const keys = await deriveLoginKeys(password, fromBase64Url(kdf.salt), costOf(kdf), secretKey)
      if (secretKey && secretKey !== typedKey) secretKey.fill(0)
      kek = keys.kek
      // The current token: the session check above may have replaced it.
      const token = currentAccount()?.accountToken ?? account.accountToken
      let r
      try { r = await api.account.unlock(token, keys.authKey) } catch (err) {
        const next = err instanceof ApiError ? (err.details as { accountToken?: string } | undefined)?.accountToken : undefined
        if (next) { saveAccount({ ...account, accountToken: next, kdf }); throw new Error(needKey ? 'That master password or secret key is not right.' : 'That master password is not right.') }
        if (err instanceof ApiError && err.status === 401) { forgetAccount(); throw new Error('Your account sign-in on this browser has ended. Sign in again.') }
        throw err
      }
      saveAccount({ ...account, accountToken: r.accountToken, kdf: r.kdf })
      const vaultKey = await unwrapVaultKey(r.wrappedVaultKey, keys.kek, 'master')
      if (typedKey) { await storeSecretKey(email, typedKey).catch(() => {}); typedKey.fill(0) }
      session.unlock({ userId: '', email, vaultKey, accessToken: r.accessToken, refreshToken: r.refreshToken, kdf: r.kdf, accessExpiresAt: session.expiresAtFrom(r) })
      void api.passwordScore(r.accessToken, passwordStrength(password).score).catch(() => {})
    } catch (err) {
      setError(rateLimited(err) ?? (err instanceof UnsealError ? 'The vault did not open. The stored key may be damaged.'
        : err instanceof SecretKeyFormatError ? err.message : err instanceof Error ? err.message : 'Something went wrong.'))
    } finally {
      if (kek) wipe(kek)
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)}>
      <span className="step">{t('Step 2 of 2')}</span>
      <h2 className="auth-title">{forAdmin ? 'Unlock to manage' : t('Unlock your vault')}</h2>
      <p className="auth-sub account-line">{t('Signed in as')} <strong>{account.email}</strong> · <button type="button" className="link" onClick={() => void signOutAccount()}>{t('Not you? Sign out')}</button></p>
      <div className="field">
        <label htmlFor="password">{t('Master password')}</label>
        <PasswordInput id="password" autoComplete="current-password" required autoFocus value={password} onChange={setPassword} />
      </div>
      {needKey ? (
        <div className="field">
          <label htmlFor="secret-key">{t('Secret key')}</label>
          <input id="secret-key" autoComplete="off" spellCheck={false} placeholder="SK1-XXXX-XXXX-…" value={secretText} onChange={(e) => setSecretText(e.target.value)} />
          <p className="hint">{t('From your Emergency Kit. Asked for once on each new browser.')}</p>
        </div>
      ) : null}
      {error ? <p className="alert alert-error"><IconAlert size={16} />{error}</p> : null}
      {heldButRefused ? (
        <p><button type="button" className="link" onClick={() => { void forgetSecretKey(account.email).then(() => { setHeldButRefused(false); setError('') }) }}>
          {t('I removed it — forget the secret key on this browser')}</button></p>
      ) : null}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy || !password || !checked}>
        {busy ? <><span className="spinner" />{t('Deriving key…')}</> : t('Unlock')}
      </button>
      <PasskeyButton busy={busy} onError={setError} />
      <p className="auth-forgot"><button type="button" className="link" onClick={onRecover}>{t('Forgot your master password? Use your recovery key')}</button></p>
    </form>
  )
}

// ── Choosing an account password (first time) ──────────────────────────────

export function SetAccountPassword({ state, masterPassword, onDone }: { state: session.Unlocked; masterPassword: string; onDone: () => void }) {
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (pw.length < MIN_ACCOUNT) return setError(`At least ${MIN_ACCOUNT} characters.`)
    if (pw !== confirm) return setError('The two passwords do not match.')
    if (pw === masterPassword) return setError('Choose something different from your master password: one leaked password must not open both.')
    setBusy(true)
    try {
      const params = newAccountParams()
      const r = await api.account.setPassword(state.accessToken, { account: { ...params, proof: await deriveAccountProof(pw, params) } })
      saveAccount({ email: state.email, accountToken: r.accountToken, kdf: state.kdf })
      onDone()
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save it.') } finally { setBusy(false) }
  }
  return (
    <form onSubmit={(e) => void submit(e)}>
      <h2 className="auth-title">{t('Choose an account password')}</h2>
      <p className="auth-sub">From now on you sign in with your email and this password (and two-factor, if it is on), then unlock with your master password. It must be different from the master password. If you forget it, it can be reset by email; your master password cannot.</p>
      <div className="field"><label htmlFor="new-account">{t('Account password')}</label><PasswordInput id="new-account" autoComplete="new-password" required autoFocus value={pw} onChange={setPw} /></div>
      <div className="field"><label htmlFor="new-account-confirm">{t('Confirm account password')}</label><PasswordInput id="new-account-confirm" autoComplete="new-password" required value={confirm} onChange={setConfirm} /></div>
      {error ? <p className="alert alert-error"><IconAlert size={16} />{error}</p> : null}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy || !pw || !confirm}>{busy ? <span className="spinner" /> : null}{t('Save and open my vault')}</button>
    </form>
  )
}

// ── Forgotten account password ─────────────────────────────────────────────

export function ForgotAccountPassword({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ mail: boolean } | null>(null)
  const [error, setError] = useState('')
  if (done) {
    return (
      <div>
        <h2 className="auth-title">{t('Check your email')}</h2>
        <p className="auth-sub">{done.mail ? `If ${email} has an account here, a link to reset its account password is on its way. It works once, for 30 minutes.`
          : 'This server does not send email. Ask the person who runs it to reset your account password; you then sign in once with your master password and choose a new one.'}</p>
        <button type="button" className="btn btn-secondary btn-block" onClick={onBack}>{t('Back to sign in')}</button>
      </div>
    )
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); setBusy(true); setError(''); void api.account.forgot(email).then((r) => setDone({ mail: r.mail })).catch((err: unknown) => setError(rateLimited(err) ?? (err instanceof Error ? err.message : 'Something went wrong.'))).finally(() => setBusy(false)) }}>
      <button type="button" className="back-link" onClick={onBack}><IconArrowLeft size={16} />{t('Back to sign in')}</button>
      <h2 className="auth-title">{t('Reset your account password')}</h2>
      <p className="auth-sub">We will email a link. This resets only the account password; your vault still needs your master password, which nobody can reset.</p>
      <div className="field"><label htmlFor="forgot-email">{t('Email')}</label><input id="forgot-email" type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></div>
      {error ? <p className="alert alert-error"><IconAlert size={16} />{error}</p> : null}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy || !email}>{busy ? <span className="spinner" /> : null}{t('Send the link')}</button>
    </form>
  )
}

export function ResetAccountPassword({ email, code, onDone }: { email: string; code: string; onDone: () => void }) {
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (pw.length < MIN_ACCOUNT) return setError(`At least ${MIN_ACCOUNT} characters.`)
    if (pw !== confirm) return setError('The two passwords do not match.')
    setBusy(true)
    try {
      // The check that it is not the master password needs its settings.
      const { kdf } = await api.prelogin(email)
      await api.account.reset(email, code, await accountPasswordPayload(pw, kdf))
      forgetAccount()
      setDone(true)
    } catch (err) { setError(rateLimited(err) ?? (err instanceof Error ? err.message : 'Could not reset it.')) } finally { setBusy(false) }
  }
  if (done) {
    return (
      <div>
        <h2 className="auth-title">{t('Account password changed')}</h2>
        <p className="auth-sub">Every device was signed out. Sign in with the new account password, then your master password.</p>
        <button type="button" className="btn btn-primary btn-block" onClick={onDone}>{t('Sign in')}</button>
      </div>
    )
  }
  return (
    <form onSubmit={(e) => void submit(e)}>
      <h2 className="auth-title">{t('New account password')}</h2>
      <p className="auth-sub">For <strong>{email}</strong>. Different from your master password.</p>
      <div className="field"><label htmlFor="reset-account">{t('Account password')}</label><PasswordInput id="reset-account" autoComplete="new-password" required autoFocus value={pw} onChange={setPw} /></div>
      <div className="field"><label htmlFor="reset-account-confirm">{t('Confirm account password')}</label><PasswordInput id="reset-account-confirm" autoComplete="new-password" required value={confirm} onChange={setConfirm} /></div>
      {error ? <p className="alert alert-error"><IconAlert size={16} />{error}</p> : null}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy || !pw || !confirm}>{busy ? <span className="spinner" /> : null}{t('Set it')}</button>
    </form>
  )
}
