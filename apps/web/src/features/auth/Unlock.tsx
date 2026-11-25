import { useEffect, useState } from 'react'

import { passwordStrength } from '@vault/core'

import { SecretKeyFormatError, UnsealError, costOf, deriveLoginKeys, kdfProblem, fromBase64Url, parseSecretKey, unwrapVaultKey, wipe } from '@vault/crypto'

import { ApiError, type SecondFactor, type SecondFactorOffer, api } from '../../lib/api.js'
import { useInstance } from '../../lib/instance.js'
import { NoPrfError, passkeysOffered, signInWithPasskey } from '../../lib/passkey.js'
import { forgetSecretKey, loadSecretKey, storeSecretKey } from '../../lib/secretkey.js'
import * as session from '../../lib/session.js'
import { IconAlert, IconFingerprint } from '../../ui/icons.js'
import { PasswordInput } from '../../ui/kit.js'
import { SecondFactorStep } from '../../ui/SecondFactor.js'
import { t } from '../../lib/i18n.js'

export function Unlock({ onRegister, onRecover, onRequestAccess, onSigninHelp, forAdmin = false, sso = null, ssoError = '', onSsoCancel }: {
  onRegister: () => void; onRecover: () => void; onRequestAccess: () => void; onSigninHelp: () => void; forAdmin?: boolean
  /** Back from the identity provider (decisions/0021): its ticket and the account it named. */
  sso?: { ticket: string; email: string } | null; ssoError?: string; onSsoCancel?: () => void
}) {
  const instance = useInstance()
  const mode = instance?.registration
  const deskOn = instance?.features?.serviceDesk ?? true
  const [email, setEmail] = useState(sso?.email ?? '')
  useEffect(() => { if (sso) setEmail(sso.email) }, [sso])
  // When the server requires single sign-on, the password-only form is for
  // owners (who are exempt) and stays folded away.
  const [ownerPath, setOwnerPath] = useState(false)
  const ssoOffer = instance?.sso ?? null
  const ssoOnly = !!ssoOffer?.required && !sso && !ownerPath
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Set once the password is proved and the server asks for a second factor.
  // The derived keys wait here, in memory, until the code is in.
  const [pending, setPending] = useState<{ authKey: string; kek: Uint8Array; typedKey?: Uint8Array } | null>(null)
  // A secret key (decisions/0027): asked for when the account has one and this
  // browser does not hold it yet; kept here once sign-in succeeds.
  const [needKey, setNeedKey] = useState(false)
  const [secretText, setSecretText] = useState('')
  const [heldButRefused, setHeldButRefused] = useState(false)
  const [offer, setOffer] = useState<SecondFactorOffer | null>(null)
  // Unlock with a passkey (decisions/0034): offered where the browser can.
  const [passkeys, setPasskeys] = useState(false)
  useEffect(() => { void passkeysOffered().then(setPasskeys) }, [])

  async function withPasskey() {
    setError('')
    setBusy(true)
    try {
      await signInWithPasskey(sso?.ticket)
    } catch (err) {
      if (err instanceof NoPrfError) setError(err.message)
      else if (err instanceof DOMException) setError('No passkey was used. If you have not added one, sign in with your master password and add it in Settings → Security.')
      else if (err instanceof ApiError && err.code === 'invalid_credentials') setError(err.message)
      else explain(err)
    } finally {
      setBusy(false)
    }
  }

  function explain(err: unknown) {
    if (err instanceof UnsealError) {
      // The server accepted the auth key but the blob would not open. That
      // is corruption or the wrong account, not a wrong password.
      setError('The vault did not open. The stored key may be damaged.')
    } else if (err instanceof ApiError && (err.code === 'invalid_two_factor' || err.code === 'network_not_allowed' || err.code === 'sso_required' || err.code === 'sso_invalid')) {
      setError(err.message)
    } else if (err instanceof ApiError && err.status === 403) {
      setError('This account has been disabled. Contact the person who runs this vault.')
    } else if (err instanceof ApiError && err.status === 401) {
      setError(needKey ? 'Wrong email, master password or secret key.' : 'Wrong email or master password.')
    } else if (err instanceof SecretKeyFormatError) {
      setError(err.message)
    } else if (err instanceof ApiError && err.status === 429) {
      const wait = err.retryAfter ? Math.ceil(err.retryAfter / 60) : null
      setError(wait ? `Too many attempts. Try again in ${wait} minute(s).` : err.message)
    } else {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    }
  }

  /** Steps 3 and 4: prove the password (and the second factor, if asked),
   *  then unwrap the vault key here. A wrong password fails at the server; a
   *  damaged key fails in this browser. */
  async function finish(authKey: string, kek: Uint8Array, second?: SecondFactor, typedKey?: Uint8Array) {
    const result = await api.login(email, authKey, second, sso?.ticket)
    const vaultKey = await unwrapVaultKey(result.wrappedVaultKey, kek, 'master')
    if (typedKey) { await storeSecretKey(email, typedKey).catch(() => {}); typedKey.fill(0) }
    session.unlock({
      userId: '',
      email,
      vaultKey,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      kdf: result.kdf,
      accessExpiresAt: session.expiresAtFrom(result),
    })
    // Organization policies may ask for a strong master password; the
    // server never sees it, so this app reports its score.
    void api.passwordScore(result.accessToken, passwordStrength(password).score).catch(() => {})
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError('')
    setBusy(true)
    let kek: Uint8Array | null = null
    let keep = false
    try {
      // 1. Fetch the salt. An address with no account gets a decoy, so this
      //    reply does not say whether one exists.
      // A typed secret key is checked first: a typo costs no sign-in attempt.
      const typedEarly = needKey && secretText.trim() ? await parseSecretKey(secretText) : undefined
      const { kdf } = await api.prelogin(email)
      // A secret key this browser holds is always used. If the server says the
      // account has none, stop: a password-only auth key is what a server
      // that dropped the flag would want, to guess the password offline.
      const held = await loadSecretKey(email)
      if (held && kdf.version !== 2) {
        held.fill(0)
        setHeldButRefused(true)
        setError('This browser holds a secret key for this account, but the server says the account has none. If you removed it on another device, forget it here; otherwise do not continue.')
        return
      }
      let secretKey: Uint8Array | undefined = held ?? undefined
      let typedKey: Uint8Array | undefined
      if (kdf.version === 2 && !secretKey) {
        if (!needKey || !secretText.trim()) {
          setNeedKey(true)
          setError('This account uses a secret key. Enter it from your Emergency Kit; this browser keeps it after that.')
          return
        }
        secretKey = typedKey = typedEarly ?? await parseSecretKey(secretText)
      } else typedEarly?.fill(0)
      // 2. Derive, on this device: Argon2id at 64 MiB (or PBKDF2 for an
      //    account not yet upgraded). The pause before the vault opens is the
      //    pause an attacker faces per guess. Settings the server sends are
      //    bounded, so it cannot ask for a weak or endless derivation.
      if (kdfProblem(kdf)) throw new Error('The server sent key settings Vault does not use, so nothing was derived.')
      const keys = await deriveLoginKeys(password, fromBase64Url(kdf.salt), costOf(kdf), secretKey)
      if (secretKey && secretKey !== typedKey) secretKey.fill(0)
      kek = keys.kek
      try {
        await finish(keys.authKey, keys.kek, undefined, typedKey)
        setSecretText('')
      } catch (err) {
        if (err instanceof ApiError && err.code === 'two_factor_required') {
          keep = true
          setPending({ authKey: keys.authKey, kek: keys.kek, ...(typedKey ? { typedKey } : {}) })
          setOffer((err.details as SecondFactorOffer | undefined) ?? null)
          return
        }
        throw err
      }
    } catch (err) {
      explain(err)
    } finally {
      if (kek && !keep) wipe(kek)
      setBusy(false)
    }
  }

  async function submitSecond(second: SecondFactor) {
    if (!pending) return
    setError('')
    setBusy(true)
    try {
      await finish(pending.authKey, pending.kek, second, pending.typedKey)
      wipe(pending.kek)
      setSecretText('')
    } catch (err) {
      explain(err)
      setBusy(false)
      // A key's challenge works once: ask for a fresh one for the next try.
      if ('webauthn' in second) {
        try { await api.login(email, pending.authKey, undefined, sso?.ticket) } catch (again) {
          if (again instanceof ApiError && again.code === 'two_factor_required') setOffer((again.details as SecondFactorOffer | undefined) ?? null)
        }
      }
    }
  }

  function cancelSecond() {
    if (pending) { wipe(pending.kek); pending.typedKey?.fill(0) }
    setPending(null)
    setError('')
  }

  if (pending) return <SecondFactorStep onSubmit={submitSecond} onCancel={cancelSecond} busy={busy} error={error} offer={offer} />

  return (
    <form onSubmit={submit} noValidate={false}>
      {forAdmin ? (
        <>
          <h2 className="auth-title">Sign in to the admin console</h2>
          <p className="auth-sub">Use your Vault account. What you can manage depends on your role: the server, or the organizations you run.</p>
        </>
      ) : (
        <>
          <h2 className="auth-title">{t('Unlock your vault')}</h2>
          <p className="auth-sub">{t('Enter your email and master password. Decryption happens in this browser.')}</p>
        </>
      )}

      {ssoError ? <p className="alert alert-error"><IconAlert size={16} />{ssoError}</p> : null}
      {sso ? (
        <p className="alert alert-info sso-banner"><span>{ssoOffer?.name ?? 'Your identity provider'} signed you in as <strong>{sso.email}</strong>. Enter your master password: it, not the provider, opens your vault.{' '}
          <button type="button" className="link" onClick={onSsoCancel}>Not you?</button></span></p>
      ) : ssoOffer ? (
        <>
          <a className={`btn ${ssoOffer.required ? 'btn-primary' : 'btn-secondary'} btn-block sso-start`} href="/api/auth/sso/start">{t('Sign in with')} {ssoOffer.name}</a>
          {ssoOnly ? (
            <p className="hint sso-owner"><button type="button" className="link" onClick={() => setOwnerPath(true)}>Server owner? Sign in with your master password</button></p>
          ) : <div className="auth-or"><span>{t('or')}</span></div>}
        </>
      ) : null}

      {ssoOnly ? null : <>
      <div className="field">
        <label htmlFor="email">{t('Email')}</label>
        <input id="email" type="email" autoComplete="username" required autoFocus={!ssoOffer}
               placeholder="you@example.com" readOnly={!!sso}
               value={email} onChange={(e) => { setEmail(e.target.value); setHeldButRefused(false) }} />
      </div>

      <div className="field">
        <label htmlFor="password">{t('Master password')}</label>
        <PasswordInput id="password" autoComplete="current-password" required
                       value={password} onChange={setPassword} />
      </div>

      {needKey ? (
        <div className="field">
          <label htmlFor="secret-key">{t('Secret key')}</label>
          <input id="secret-key" autoComplete="off" spellCheck={false} placeholder="SK1-XXXX-XXXX-…"
                 value={secretText} onChange={(e) => setSecretText(e.target.value)} />
          <p className="hint">{t('From your Emergency Kit. Asked for once on each new browser.')}</p>
        </div>
      ) : null}

      {error ? <p className="alert alert-error"><IconAlert size={16} />{error}</p> : null}
      {heldButRefused ? (
        <p><button type="button" className="link" onClick={() => { void forgetSecretKey(email).then(() => { setHeldButRefused(false); setError('') }) }}>
          {t('I removed it — forget the secret key on this browser')}</button></p>
      ) : null}

      <button type="submit" className="btn btn-primary btn-block" disabled={busy || !email || !password}>
        {busy ? <><span className="spinner" />{t('Deriving key…')}</> : t('Unlock')}
      </button>

      {passkeys ? (
        <>
          <div className="auth-or"><span>{t('or')}</span></div>
          <button type="button" className="btn btn-secondary btn-block" disabled={busy} onClick={() => void withPasskey()}>
            <IconFingerprint size={16} />{t('Sign in with a passkey')}
          </button>
        </>
      ) : null}

      </>}

      <p className="auth-forgot">
        <button type="button" className="link" onClick={onRecover}>{t('Forgot your master password? Use your recovery key')}</button>
        {/* Help comes from the service desk; a personal Vault has nobody to ask (decisions/0030). */}
        {deskOn ? <><br />
        <button type="button" className="link" onClick={onSigninHelp}>{t('Lost your authenticator, or can\'t sign in? Ask for help')}</button></> : null}
      </p>

      {/* Only the ways in this server actually offers (GET /api/instance). */}
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
