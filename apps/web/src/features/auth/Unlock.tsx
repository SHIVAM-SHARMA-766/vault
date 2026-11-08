import { useState } from 'react'

import { passwordStrength } from '@vault/core'

import { SecretKeyFormatError, UnsealError, deriveLoginKeys, fromBase64Url, parseSecretKey, unwrapVaultKey, wipe } from '@vault/crypto'

import { ApiError, type SecondFactor, type SecondFactorOffer, api } from '../../lib/api.js'
import { useInstance } from '../../lib/instance.js'
import { forgetSecretKey, loadSecretKey, storeSecretKey } from '../../lib/secretkey.js'
import * as session from '../../lib/session.js'
import { IconAlert } from '../../ui/icons.js'
import { PasswordInput } from '../../ui/kit.js'
import { SecondFactorStep } from '../../ui/SecondFactor.js'
import { t } from '../../lib/i18n.js'

export function Unlock({ onRegister, onRecover, onRequestAccess, onSigninHelp, forAdmin = false }: {
  onRegister: () => void; onRecover: () => void; onRequestAccess: () => void; onSigninHelp: () => void; forAdmin?: boolean
}) {
  const instance = useInstance()
  const mode = instance?.registration
  const [email, setEmail] = useState('')
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

  function explain(err: unknown) {
    if (err instanceof UnsealError) {
      // The server accepted the auth key but the blob would not open. That
      // is corruption or the wrong account, not a wrong password.
      setError('The vault did not open. The stored key may be damaged.')
    } else if (err instanceof ApiError && (err.code === 'invalid_two_factor' || err.code === 'network_not_allowed')) {
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
    const result = await api.login(email, authKey, second)
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
      // 2. Derive, on this device. 600,000 iterations — the pause before the
      //    vault opens is the same pause an attacker faces per guess.
      const keys = await deriveLoginKeys(password, fromBase64Url(kdf.salt), kdf.iterations, secretKey)
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
        try { await api.login(email, pending.authKey) } catch (again) {
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
          <h2 className="auth-title">Sign in to the admin panel</h2>
          <p className="auth-sub">Use your Vault account. What you can do in the panel depends on the role the owner gave you.</p>
        </>
      ) : (
        <>
          <h2 className="auth-title">{t('Unlock your vault')}</h2>
          <p className="auth-sub">{t('Enter your email and master password. Decryption happens in this browser.')}</p>
        </>
      )}

      <div className="field">
        <label htmlFor="email">{t('Email')}</label>
        <input id="email" type="email" autoComplete="username" required autoFocus
               placeholder="you@example.com"
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

      <p className="auth-forgot">
        <button type="button" className="link" onClick={onRecover}>{t('Forgot your master password? Use your recovery key')}</button>
        <br />
        <button type="button" className="link" onClick={onSigninHelp}>{t('Lost your authenticator, or can\'t sign in? Ask for help')}</button>
      </p>

      {/* Only the ways in this server actually offers (GET /api/instance). */}
      <p className="auth-switch">
        {mode === 'open' ? <>New here? <button type="button" className="link" onClick={onRegister}>{t('Create an account')}</button></>
          : mode === 'closed' && instance?.firstRun ? <>New server? <button type="button" className="link" onClick={onRegister}>Create the owner account</button> with the setup code from its log</>
          : mode === 'closed' ? <>New here? <button type="button" className="link" onClick={onRequestAccess}>{t('Request access')}</button></>
          : <>{mode === 'invite' ? 'Have an invitation?' : 'New here?'} <button type="button" className="link" onClick={onRegister}>{t('Create an account')}</button>
            {' · '}<button type="button" className="link" onClick={onRequestAccess}>{t('Request access')}</button></>}
      </p>
    </form>
  )
}
