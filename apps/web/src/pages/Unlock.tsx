import { useState } from 'react'

import { UnsealError, deriveLoginKeys, fromBase64Url, unwrapVaultKey, wipe } from '@vault/crypto'

import { ApiError, api } from '../api.js'
import * as session from '../session.js'
import { IconAlert } from '../icons.js'
import { PasswordInput } from '../ui.js'

export function Unlock({ onRegister, forAdmin = false }: { onRegister: () => void; forAdmin?: boolean }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError('')
    setBusy(true)

    let kek: Uint8Array | null = null
    try {
      // 1. Fetch the salt. An address with no account gets a decoy, so this
      //    reply does not say whether one exists.
      const { kdf } = await api.prelogin(email)

      // 2. Derive, on this device. 600,000 iterations — the pause before the
      //    vault opens is the same pause an attacker faces per guess.
      const keys = await deriveLoginKeys(password, fromBase64Url(kdf.salt), kdf.iterations)
      kek = keys.kek

      // 3. Prove the password with the auth key. The password itself, and the
      //    key that decrypts the vault, stay here.
      const result = await api.login(email, keys.authKey)

      // 4. Unwrap locally. A wrong password fails here, not at the server.
      const vaultKey = await unwrapVaultKey(result.wrappedVaultKey, keys.kek, 'master')

      session.unlock({
        userId: '',
        email,
        vaultKey,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        kdf: result.kdf,
        accessExpiresAt: session.expiresAtFrom(result),
      })
    } catch (err) {
      if (err instanceof UnsealError) {
        // The server accepted the auth key but the blob would not open. That
        // is corruption or the wrong account, not a wrong password.
        setError('The vault did not open. The stored key may be damaged.')
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
    } finally {
      if (kek) wipe(kek)
      setBusy(false)
    }
  }

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

      <p className="auth-switch">
        New here? <button type="button" className="link" onClick={onRegister}>Create an account</button>
      </p>
    </form>
  )
}
