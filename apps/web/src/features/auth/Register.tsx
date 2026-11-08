import { useState } from 'react'

import { createAccount, deriveRecoveryProof } from '@vault/crypto'

import { newIdentity } from '../../lib/identity.js'

import { ApiError, api } from '../../lib/api.js'
import { useInstance } from '../../lib/instance.js'
import * as session from '../../lib/session.js'
import { IconAlert, IconArrowLeft } from '../../ui/icons.js'
import { Check, CopyButton, PasswordInput, StrengthMeter } from '../../ui/kit.js'

/** Short enough not to be theatre, long enough that 600,000 PBKDF2 iterations
 *  are doing work rather than papering over a guessable secret. */
const MIN_LENGTH = 12

export function Register({ onDone, onCancel, setupCode = '', inviteCode: invited = '' }: { onDone: () => void; onCancel: () => void; setupCode?: string; inviteCode?: string }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [recoveryKey, setRecoveryKey] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [inviteCode, setInviteCode] = useState((setupCode || invited).toUpperCase())
  const mode = useInstance()?.registration
  const [showInvite, setShowInvite] = useState(false)
  const owner = setupCode !== ''

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
      // The key pair other people will share with. Made here, with the vault
      // key, so every new account has one from the start.
      const identity = await newIdentity(account.vaultKey)

      const result = await api.register({
        email,
        authKey: account.authKey,
        recoveryAuthKey: recoveryProof,
        kdf: account.kdf,
        wrappedVaultKey: account.wrappedVaultKey,
        wrappedVaultKeyForRecovery: account.wrappedVaultKeyForRecovery,
        ...(inviteCode.trim() ? { inviteCode: inviteCode.trim() } : {}),
        identity,
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
        // Deliberately the same for a bad invitation and an address that
        // already has an account: sign-up must not reveal which (A7).
        setError(inviteCode.trim() || setupCode ? err.message : 'New accounts need an invitation code on this server — or, if you already have an account, sign in.')
      } else {
        setError(err instanceof Error ? err.message : 'Something went wrong.')
      }
    } finally {
      setBusy(false)
    }
  }

  if (recoveryKey) {
    return (
      <div>
        <span className="step">Step 2 of 2</span>
        <h2 className="auth-title">Save your recovery key</h2>
        <p className="auth-sub">
          This is the only way back into your vault if you forget the master password. It is
          shown once, it was never sent to the server, and nobody can reissue it.
        </p>
        <div className="recovery-key">
          <code>{recoveryKey}</code>
          <CopyButton value={recoveryKey} label="Recovery key" />
        </div>
        <p className="alert alert-warn"><IconAlert size={16} />
          Lose both this key and your master password and the vault cannot be opened — by anyone.
        </p>
        <Check checked={acknowledged} onChange={setAcknowledged}>
          I have stored the recovery key somewhere safe, off this device.
        </Check>
        <button type="button" className="btn btn-primary btn-block" disabled={!acknowledged} onClick={onDone}>
          Continue to sign in
        </button>
      </div>
    )
  }

  const mismatch = confirm.length > 0 && confirm !== password

  return (
    <form onSubmit={submit}>
      <button type="button" className="back-link" onClick={onCancel}><IconArrowLeft size={16} />Back to sign in</button>
      <span className="step">Step 1 of 2</span>
      <h2 className="auth-title">{owner ? 'Create the owner account' : 'Create your vault'}</h2>
      <p className="auth-sub">
        {owner ? 'This is a new Vault server. The account you create now owns it: you can invite people and manage the server from the admin panel. ' : ''}
        There is no password reset. The server cannot read your vault, so it cannot help you
        back in — the recovery key issued next is the only other way.
      </p>

      {/* An open server needs no code; any other needs one (GET /api/instance). */}
      {!owner && mode === 'open' && !invited && !showInvite ? (
        <p className="hint"><button type="button" className="link" onClick={() => setShowInvite(true)}>I have an invitation code</button></p>
      ) : null}
      {owner || (mode === 'open' && !invited && !showInvite) ? null : <div className="field">
        <label htmlFor="r-invite">Invitation code</label>
        <input id="r-invite" autoComplete="off" spellCheck={false} className="mono" required={mode !== undefined && mode !== 'open'}
               placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
               value={inviteCode} onChange={(e) => setInviteCode(e.target.value.toUpperCase())} />
        <p className="hint">{mode === undefined ? 'Accounts are opened by invitation. Leave blank only if registration is open.'
          : 'This server opens accounts by invitation. It is in the email you were sent, or ask the person who runs it.'}</p>
      </div>}

      <div className="field">
        <label htmlFor="r-email">Email</label>
        <input id="r-email" type="email" autoComplete="username" required autoFocus
               placeholder="you@example.com"
               value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>

      <div className="field">
        <label htmlFor="r-password">Master password</label>
        <PasswordInput id="r-password" autoComplete="new-password" required
                       value={password} onChange={setPassword} />
        <StrengthMeter password={password} />
        <p className="hint">At least {MIN_LENGTH} characters. A long passphrase of unrelated words works well.</p>
      </div>

      <div className="field">
        <label htmlFor="r-confirm">Confirm master password</label>
        <PasswordInput id="r-confirm" autoComplete="new-password" required
                       value={confirm} onChange={setConfirm} />
        {mismatch ? <p className="hint hint-error">The passwords do not match yet.</p> : null}
      </div>

      {error ? <p className="alert alert-error"><IconAlert size={16} />{error}</p> : null}

      <button type="submit" className="btn btn-primary btn-block" disabled={busy || !email || !password || !confirm}>
        {busy ? <><span className="spinner" />Generating keys…</> : 'Create vault'}
      </button>
    </form>
  )
}
