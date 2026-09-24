import { useState } from 'react'

import { UnsealError, deriveLoginKeys, fromBase64Url, unwrapVaultKey, wipe } from '@vault/crypto'

import { ApiError, api } from '../api.js'
import * as session from '../session.js'

export function Unlock({ onRegister }: { onRegister: () => void }) {
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
    <form className="panel" onSubmit={submit}>
      <label htmlFor="email">Email</label>
      <input id="email" type="email" autoComplete="username" required
             value={email} onChange={(e) => setEmail(e.target.value)} />

      <label htmlFor="password">Master password</label>
      <input id="password" type="password" autoComplete="current-password" required
             value={password} onChange={(e) => setPassword(e.target.value)} />

      {error ? <p className="error">{error}</p> : null}

      <div className="row between" style={{ marginTop: 20 }}>
        <button type="submit" disabled={busy || !email || !password}>
          {busy ? 'Deriving key…' : 'Unlock'}
        </button>
        <button type="button" className="secondary" onClick={onRegister}>
          Create an account
        </button>
      </div>
    </form>
  )
}
