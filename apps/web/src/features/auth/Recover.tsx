// Getting back in with the recovery key, when the master password is gone.
//
// Two steps, both in this browser: the recovery key unwraps the vault key
// (the server hands over only the copy wrapped for recovery, after the key is
// proved through its own HKDF branch), and then a new master password rewraps
// it. The server never sees either key. Signing in this way signs out every
// other session.

import { useState } from 'react'

import { UnsealError, changePassword, deriveRecoveryProof, unlockWithRecoveryKey } from '@vault/crypto'

import { ApiError, type SecondFactor, api } from '../../lib/api.js'
import { newKdfCost } from '../../lib/kdf.js'
import * as session from '../../lib/session.js'
import { loadSecretKey } from '../../lib/secretkey.js'
import { IconAlert, IconArrowLeft } from '../../ui/icons.js'
import { PasswordInput, StrengthMeter } from '../../ui/kit.js'
import { SecondFactorStep } from '../../ui/SecondFactor.js'

const MIN_LENGTH = 12

type Step =
  | { kind: 'key' }
  | { kind: 'second'; proof: string; key: string }
  | { kind: 'password'; vaultKey: Uint8Array; proof: string; token: string }

export function Recover({ onCancel, sso = null }: { onCancel: () => void; sso?: { ticket: string; email: string } | null }) {
  const [step, setStep] = useState<Step>({ kind: 'key' })
  const [email, setEmail] = useState(sso?.email ?? '')
  const [recoveryKey, setRecoveryKey] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  function explain(err: unknown) {
    setError(err instanceof ApiError && err.code === 'invalid_two_factor' ? err.message
      : err instanceof ApiError && err.status === 401 ? 'That email and recovery key do not match an account.'
      : err instanceof ApiError && err.status === 429 ? 'Too many attempts. Try again later.'
      : err instanceof UnsealError ? 'The recovery key was accepted but the vault did not open. The stored key may be damaged.'
      : err instanceof Error ? err.message : 'Something went wrong.')
  }

  async function open(proof: string, key: string, second?: SecondFactor) {
    const res = await api.recoveryLogin(email, proof, second, sso?.ticket)
    const vaultKey = await unlockWithRecoveryKey(key, res.wrappedVaultKeyForRecovery)
    setStep({ kind: 'password', vaultKey, proof, token: res.accessToken })
    setRecoveryKey('')
  }

  async function useKey(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      let proof: string
      try {
        proof = await deriveRecoveryProof(recoveryKey.trim())
      } catch {
        throw new Error('That does not look like a recovery key. Check it against the one you saved.')
      }
      try {
        await open(proof, recoveryKey.trim())
      } catch (err) {
        if (err instanceof ApiError && err.code === 'two_factor_required') {
          setStep({ kind: 'second', proof, key: recoveryKey.trim() })
          return
        }
        throw err
      }
    } catch (err) {
      explain(err)
    } finally {
      setBusy(false)
    }
  }

  async function submitSecond(second: SecondFactor) {
    if (step.kind !== 'second') return
    setError('')
    setBusy(true)
    try {
      await open(step.proof, step.key, second)
    } catch (err) {
      explain(err)
    } finally {
      setBusy(false)
    }
  }

  async function setPassword(e: React.FormEvent) {
    e.preventDefault()
    if (step.kind !== 'password') return
    setError('')
    if (next.length < MIN_LENGTH) return setError(`The new master password must be at least ${MIN_LENGTH} characters.`)
    if (next !== confirm) return setError('The two passwords do not match.')
    setBusy(true)
    try {
      // A secret key this browser holds is kept; without it, the reset turns the
      // secret key off, which is how someone who lost it gets back in (0027).
      const held = await loadSecretKey(email)
      const changed = await changePassword(next, step.vaultKey, await newKdfCost(), held ?? undefined)
      held?.fill(0)
      const res = await api.changePassword(step.token, {
        recoveryAuthKey: step.proof, newAuthKey: changed.authKey, kdf: changed.kdf, wrappedVaultKey: changed.wrappedVaultKey,
      })
      session.unlock({
        userId: '', email, vaultKey: step.vaultKey,
        accessToken: res.accessToken, refreshToken: res.refreshToken,
        kdf: changed.kdf, accessExpiresAt: session.expiresAtFrom(res),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set the new master password.')
      setBusy(false)
    }
  }

  if (step.kind === 'second') {
    return <SecondFactorStep onSubmit={submitSecond} onCancel={() => { setStep({ kind: 'key' }); setError('') }} busy={busy} error={error} />
  }

  if (step.kind === 'password') {
    return (
      <form onSubmit={setPassword}>
        <span className="step">Step 2 of 2</span>
        <h2 className="auth-title">Choose a new master password</h2>
        <p className="auth-sub">Your vault is open in this browser. Set the password you will use from now on — every other device has been signed out.</p>
        <div className="field">
          <label htmlFor="rc-new">New master password</label>
          <PasswordInput id="rc-new" autoComplete="new-password" required autoFocus value={next} onChange={setNext} />
          <StrengthMeter password={next} />
        </div>
        <div className="field">
          <label htmlFor="rc-confirm">Confirm new master password</label>
          <PasswordInput id="rc-confirm" autoComplete="new-password" required value={confirm} onChange={setConfirm} />
        </div>
        {error ? <p className="alert alert-error"><IconAlert size={16} />{error}</p> : null}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy || !next || !confirm}>
          {busy ? <><span className="spinner" />Saving…</> : 'Set master password and open vault'}
        </button>
        <p className="hint">Your recovery key keeps working. Issue a new one in Account settings if it may have been seen.</p>
      </form>
    )
  }

  return (
    <form onSubmit={useKey}>
      <button type="button" className="back-link" onClick={onCancel}><IconArrowLeft size={16} />Back to sign in</button>
      <span className="step">Step 1 of 2</span>
      <h2 className="auth-title">Use your recovery key</h2>
      <p className="auth-sub">The key you saved when you created your vault. It opens the vault here, then you choose a new master password.</p>
      <div className="field">
        <label htmlFor="rc-email">Email</label>
        <input id="rc-email" type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="rc-key">Recovery key</label>
        <input id="rc-key" className="mono" autoComplete="off" spellCheck={false} required value={recoveryKey}
               placeholder="XXXX-XXXX-…" onChange={(e) => setRecoveryKey(e.target.value)} />
      </div>
      {error ? <p className="alert alert-error"><IconAlert size={16} />{error}</p> : null}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy || !email || !recoveryKey}>
        {busy ? <><span className="spinner" />Checking…</> : 'Open my vault'}
      </button>
    </form>
  )
}

