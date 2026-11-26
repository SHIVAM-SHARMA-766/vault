import { useState } from 'react'

import { createAccount, deriveAccountProof, deriveRecoveryProof, newAccountParams } from '@vault/crypto'

import { saveAccount } from '../../lib/account.js'

import { newKdfCost } from '../../lib/kdf.js'
import { belowMinimum } from '@vault/core'

import { newIdentity } from '../../lib/identity.js'

import { ApiError, api } from '../../lib/api.js'
import { useInstance } from '../../lib/instance.js'
import * as session from '../../lib/session.js'
import { IconAlert, IconArrowLeft } from '../../ui/icons.js'
import { Check, CopyButton, PasswordInput, StrengthMeter } from '../../ui/kit.js'

/** Short enough not to be theatre, long enough that 600,000 PBKDF2 iterations
 *  are doing work rather than papering over a guessable secret. */
const MIN_LENGTH = 12

export function Register({ onDone, onCancel, setupCode = '', inviteCode: invited = '', sso = null }: { onDone: () => void; onCancel: () => void; setupCode?: string; inviteCode?: string; sso?: { ticket: string; email: string } | null }) {
  const [email, setEmail] = useState(sso?.email ?? '')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  // The account password (decisions/0036): the first step of every sign-in.
  const [accountPw, setAccountPw] = useState('')
  const [accountConfirm, setAccountConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [recoveryKey, setRecoveryKey] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [inviteCode, setInviteCode] = useState((setupCode || invited).toUpperCase())
  const instance = useInstance()
  const mode = instance?.registration
  const [showInvite, setShowInvite] = useState(false)
  const owner = setupCode !== ''

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError('')

    if (accountPw.length < 10) {
      setError('The account password must be at least 10 characters.')
      return
    }
    if (accountPw !== accountConfirm) {
      setError('The two account passwords do not match.')
      return
    }
    if (accountPw === password) {
      setError('Choose an account password different from the master password: one leaked password must not open both.')
      return
    }
    if (password.length < MIN_LENGTH) {
      setError(`The master password must be at least ${MIN_LENGTH} characters.`)
      return
    }
    const weak = belowMinimum(password, instance?.minPasswordScore ?? 0)
    if (weak) {
      setError(weak)
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
      const account = await createAccount(password, await newKdfCost())
      const recoveryProof = await deriveRecoveryProof(account.recoveryKey)
      // The key pair other people will share with. Made here, with the vault
      // key, so every new account has one from the start.
      const identity = await newIdentity(account.vaultKey)
      const accountParams = newAccountParams()
      const accountProof = await deriveAccountProof(accountPw, accountParams)

      const result = await api.register({
        email,
        authKey: account.authKey,
        recoveryAuthKey: recoveryProof,
        kdf: account.kdf,
        wrappedVaultKey: account.wrappedVaultKey,
        wrappedVaultKeyForRecovery: account.wrappedVaultKeyForRecovery,
        ...(inviteCode.trim() && !sso ? { inviteCode: inviteCode.trim() } : {}),
        ...(sso ? { ssoTicket: sso.ticket } : {}),
        identity,
        account: { ...accountParams, proof: accountProof },
      })
      // Signed in to the account already: next time only the master password.
      if (result.accountToken) saveAccount({ email, accountToken: result.accountToken, kdf: account.kdf })

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
      {!owner && !sso && mode === 'open' && !invited && !showInvite ? (
        <p className="hint"><button type="button" className="link" onClick={() => setShowInvite(true)}>I have an invitation code</button></p>
      ) : null}
      {sso ? <p className="alert alert-info"><span>Your identity provider signed you in as <strong>{sso.email}</strong>. Choose a master password: it, not the provider, is what opens your vault.</span></p> : null}
      {owner || sso || (mode === 'open' && !invited && !showInvite) ? null : <div className="field">
        <label htmlFor="r-invite">Invitation code</label>
        <input id="r-invite" autoComplete="off" spellCheck={false} className="mono" required={mode !== undefined && mode !== 'open'}
               placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
               value={inviteCode} onChange={(e) => setInviteCode(e.target.value.toUpperCase())} />
        <p className="hint">{mode === undefined ? 'Accounts are opened by invitation. Leave blank only if registration is open.'
          : 'This server opens accounts by invitation. It is in the email you were sent, or ask the person who runs it.'}</p>
      </div>}

      <div className="field">
        <label htmlFor="r-email">Email</label>
        <input id="r-email" type="email" autoComplete="username" required autoFocus={!sso} readOnly={!!sso}
               placeholder="you@example.com"
               value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>

      <fieldset className="pw-group">
        <legend>Account password</legend>
        <p className="hint">Step one of every sign-in, with your email (and two-factor, once you turn it on). It can be reset by email.</p>
        <div className="field">
          <label htmlFor="r-account">Account password</label>
          <PasswordInput id="r-account" autoComplete="new-password" required value={accountPw} onChange={setAccountPw} />
        </div>
        <div className="field">
          <label htmlFor="r-account-confirm">Confirm account password</label>
          <PasswordInput id="r-account-confirm" autoComplete="new-password" required value={accountConfirm} onChange={setAccountConfirm} />
          {accountConfirm && accountConfirm !== accountPw ? <p className="hint hint-error">The account passwords do not match yet.</p> : null}
        </div>
      </fieldset>

      <fieldset className="pw-group">
      <legend>Master password</legend>
      <p className="hint">Step two: it opens your vault, in this browser. Different from the account password, and nobody can reset it.</p>
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
      </fieldset>

      {error ? <p className="alert alert-error"><IconAlert size={16} />{error}</p> : null}

      <button type="submit" className="btn btn-primary btn-block" disabled={busy || !email || !password || !confirm}>
        {busy ? <><span className="spinner" />Generating keys…</> : 'Create vault'}
      </button>
    </form>
  )
}
