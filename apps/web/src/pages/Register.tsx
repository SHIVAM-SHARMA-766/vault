import { useState } from 'react'

import { createAccount, deriveRecoveryProof } from '@vault/crypto'

import { ApiError, api } from '../api.js'
import * as session from '../session.js'

/** Short enough not to be theatre, long enough that 600,000 PBKDF2 iterations
 *  are doing work rather than papering over a guessable secret. */
const MIN_LENGTH = 12

export function Register({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [recoveryKey, setRecoveryKey] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError('')

    if (password.length < MIN_LENGTH) {
      setError(`The master password must be at least ${MIN_LENGTH} characters.`)
      return
    }
    if (password !== confirm) {
      setError('The two passwords do not match.')
      return
    }

    setBusy(true)
    try {
      // Everything is generated here: the vault key, the recovery key, the
      // salt. The server receives none of them — only an auth key derived
      // through a branch it cannot work backwards, and two wrapped copies of
      // a key it cannot unwrap.
      const account = await createAccount(password)
      const recoveryProof = await deriveRecoveryProof(account.recoveryKey)

      const result = await api.register({
        email,
        authKey: account.authKey,
        recoveryAuthKey: recoveryProof,
        kdf: account.kdf,
        wrappedVaultKey: account.wrappedVaultKey,
        wrappedVaultKeyForRecovery: account.wrappedVaultKeyForRecovery,
      })

      // Shown once. It is never transmitted and cannot be recovered from the
      // server, so the vault stays locked behind this screen until it has been
      // acknowledged.
      setRecoveryKey(account.recoveryKey)

      session.unlock({
        userId: result.userId,
        email,
        vaultKey: account.vaultKey,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        kdf: account.kdf,
        accessExpiresAt: session.expiresAtFrom(result),
      })
      // Lock again immediately: the recovery key must be written down before
      // the vault is usable, and an unlocked vault behind this screen invites
      // skipping that.
      session.lock()
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setError('Registration is closed on this server.')
      } else if (err instanceof ApiError && err.status === 409) {
        setError('That address is already registered.')
      } else {
        setError(err instanceof Error ? err.message : 'Something went wrong.')
      }
    } finally {
      setBusy(false)
    }
  }

  if (recoveryKey) {
    return (
      <div className="panel">
        <h2>Write this down now</h2>
        <p className="small muted">
          This is the only way back into your vault if you forget the master password.
          It is shown once, it was never sent to the server, and nobody can reissue it.
          Lose both this and the password and the vault is gone.
        </p>
        <div className="recovery-key">{recoveryKey}</div>
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" style={{ width: 'auto' }}
                 checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
          <span className="small">I have written it down somewhere safe.</span>
        </label>
        <div style={{ marginTop: 16 }}>
          <button type="button" disabled={!acknowledged} onClick={onDone}>
            Continue to sign in
          </button>
        </div>
      </div>
    )
  }

  return (
    <form className="panel" onSubmit={submit}>
      <h2>Create an account</h2>
      <p className="small muted">
        There is no password reset. The server cannot read your vault, so it cannot help
        you back into it — a recovery key issued here is the only other way in.
      </p>

      <label htmlFor="r-email">Email</label>
      <input id="r-email" type="email" autoComplete="username" required
             value={email} onChange={(e) => setEmail(e.target.value)} />

      <label htmlFor="r-password">Master password</label>
      <input id="r-password" type="password" autoComplete="new-password" required
             value={password} onChange={(e) => setPassword(e.target.value)} />

      <label htmlFor="r-confirm">Master password again</label>
      <input id="r-confirm" type="password" autoComplete="new-password" required
             value={confirm} onChange={(e) => setConfirm(e.target.value)} />

      {error ? <p className="error">{error}</p> : null}

      <div className="row between" style={{ marginTop: 20 }}>
        <button type="submit" disabled={busy || !email || !password || !confirm}>
          {busy ? 'Generating keys…' : 'Create'}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>Back</button>
      </div>
    </form>
  )
}
