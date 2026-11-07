import { useState } from 'react'

import { passwordStrength } from '@vault/core'

import { UnsealError, deriveLoginKeys, fromBase64Url, unwrapVaultKey, wipe } from '@vault/crypto'

import { ApiError, type SecondFactor, api } from '../../lib/api.js'
import { useInstance } from '../../lib/instance.js'
import * as session from '../../lib/session.js'
import { IconAlert } from '../../ui/icons.js'
import { PasswordInput } from '../../ui/kit.js'
import { SecondFactorStep } from '../../ui/SecondFactor.js'

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
  const [pending, setPending] = useState<{ authKey: string; kek: Uint8Array } | null>(null)

  function explain(err: unknown) {
    if (err instanceof UnsealError) {
      // The server accepted the auth key but the blob would not open. That
      // is corruption or the wrong account, not a wrong password.
      setError('The vault did not open. The stored key may be damaged.')
    } else if (err instanceof ApiError && err.code === 'invalid_two_factor') {
      setError(err.message)
    } else if (err instanceof ApiError && err.status === 403) {
      setError('This account has been disabled. Contact the person who runs this vault.')
    } else if (err instanceof ApiError && err.status === 401) {
      setError('Wrong email or master password.')
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
  async function finish(authKey: string, kek: Uint8Array, second?: SecondFactor) {
    const result = await api.login(email, authKey, second)
    const vaultKey = await unwrapVaultKey(result.wrappedVaultKey, kek, 'master')
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
      const { kdf } = await api.prelogin(email)
      // 2. Derive, on this device. 600,000 iterations — the pause before the
      //    vault opens is the same pause an attacker faces per guess.
      const keys = await deriveLoginKeys(password, fromBase64Url(kdf.salt), kdf.iterations)
      kek = keys.kek
      try {
        await finish(keys.authKey, keys.kek)
      } catch (err) {
        if (err instanceof ApiError && err.code === 'two_factor_required') {
          keep = true
          setPending({ authKey: keys.authKey, kek: keys.kek })
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
      await finish(pending.authKey, pending.kek, second)
      wipe(pending.kek)
    } catch (err) {
      explain(err)
      setBusy(false)
    }
  }

  function cancelSecond() {
    if (pending) wipe(pending.kek)
    setPending(null)
    setError('')
  }

  if (pending) return <SecondFactorStep onSubmit={submitSecond} onCancel={cancelSecond} busy={busy} error={error} />

  return (
    <form onSubmit={submit} noValidate={false}>
      {forAdmin ? (
        <>
          <h2 className="auth-title">Sign in to the admin panel</h2>
          <p className="auth-sub">Use your Vault account. What you can do in the panel depends on the role the owner gave you.</p>
        </>
      ) : (
        <>
          <h2 className="auth-title">Unlock your vault</h2>
          <p className="auth-sub">Enter your email and master password. Decryption happens in this browser.</p>
        </>
      )}

      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" type="email" autoComplete="username" required autoFocus
               placeholder="you@example.com"
               value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>

      <div className="field">
        <label htmlFor="password">Master password</label>
        <PasswordInput id="password" autoComplete="current-password" required
                       value={password} onChange={setPassword} />
      </div>

      {error ? <p className="alert alert-error"><IconAlert size={16} />{error}</p> : null}

      <button type="submit" className="btn btn-primary btn-block" disabled={busy || !email || !password}>
        {busy ? <><span className="spinner" />Deriving key…</> : 'Unlock'}
      </button>

      <p className="auth-forgot">
        <button type="button" className="link" onClick={onRecover}>Forgot your master password? Use your recovery key</button>
        <br />
        <button type="button" className="link" onClick={onSigninHelp}>Lost your authenticator, or can't sign in? Ask for help</button>
      </p>

      {/* Only the ways in this server actually offers (GET /api/instance). */}
      <p className="auth-switch">
        {mode === 'open' ? <>New here? <button type="button" className="link" onClick={onRegister}>Create an account</button></>
          : mode === 'closed' && instance?.firstRun ? <>New server? <button type="button" className="link" onClick={onRegister}>Create the owner account</button> with the setup code from its log</>
          : mode === 'closed' ? <>New here? <button type="button" className="link" onClick={onRequestAccess}>Request access</button></>
          : <>{mode === 'invite' ? 'Have an invitation?' : 'New here?'} <button type="button" className="link" onClick={onRegister}>Create an account</button>
            {' · '}<button type="button" className="link" onClick={onRequestAccess}>Request access</button></>}
      </p>
    </form>
  )
}
