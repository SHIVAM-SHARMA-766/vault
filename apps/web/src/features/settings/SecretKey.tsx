// The opt-in secret key (decisions/0027): turning it on and off, and the
// Emergency Kit that carries it.
//
// Turning it on is a master password change to the same password with the
// secret key mixed in: the vault key is re-wrapped, no item is re-encrypted,
// and other devices are signed out (they need the secret key from now on).

import { useState } from 'react'

import { changePassword, formatSecretKey, generateSecretKey } from '@vault/crypto'

import { ApiError, api } from '../../lib/api.js'
import { newKdfCost } from '../../lib/kdf.js'
import { forgetSecretKey, loadSecretKey, storeSecretKey } from '../../lib/secretkey.js'
import * as session from '../../lib/session.js'
import { IconAlert, IconCheck, IconKey } from '../../ui/icons.js'
import { Check, CopyButton, PasswordInput, useToast } from '../../ui/kit.js'
import { checkMasterPassword } from '../transfer/transfer.js'
import { proveCurrent } from './prove.js'

type Mode = 'idle' | 'add' | 'show' | 'remove'

export function SecretKey({ state }: { state: session.Unlocked }) {
  const toast = useToast()
  const on = state.kdf.version === 2
  const [mode, setMode] = useState<Mode>('idle')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [kit, setKit] = useState('')
  const [saved, setSaved] = useState(false)


  /** Re-derive with or without a secret key and re-wrap the vault key. */
  async function rewrap(secretKey: Uint8Array | undefined) {
    const currentAuthKey = await proveCurrent(state, password)
    const changed = await changePassword(password, state.vaultKey, await newKdfCost(), secretKey)
    const res = await api.changePassword(await session.token(), {
      currentAuthKey, newAuthKey: changed.authKey, kdf: changed.kdf, wrappedVaultKey: changed.wrappedVaultKey,
    })
    session.patch({ kdf: changed.kdf, accessToken: res.accessToken, refreshToken: res.refreshToken, accessExpiresAt: session.expiresAtFrom(res) })
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      if (mode === 'add') {
        const sk = generateSecretKey()
        const text = await formatSecretKey(sk)
        // Kept on this device first, so a failure below cannot leave the
        // account needing a key nobody has.
        await storeSecretKey(state.email, sk)
        await rewrap(sk)
        sk.fill(0)
        setKit(text)
      } else if (mode === 'remove') {
        await rewrap(undefined)
        await forgetSecretKey(state.email)
        toast('Secret key removed. Other devices have been signed out.')
        setMode('idle')
      } else if (mode === 'show') {
        if (!(await checkMasterPassword(state, password))) throw new Error('The master password is wrong.')
        const sk = await loadSecretKey(state.email)
        if (!sk) throw new Error('This browser does not hold the secret key.')
        setKit(await formatSecretKey(sk))
        sk.fill(0)
      }
      setPassword('')
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? 'The master password is wrong.'
        : err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  if (kit) {
    return (
      <section className="settings-card" aria-labelledby="s-secret">
        <div className="settings-card-head"><IconKey size={18} /><h2 id="s-secret">Your Emergency Kit</h2></div>
        {mode === 'add' ? <p className="alert alert-warn"><IconAlert size={16} /><span>Signing in on any other device now needs this secret key. Print the kit or write it down, and keep it away from this device.</span></p> : null}
        <EmergencyKit email={state.email} secretKey={kit} />
        <div className="settings-actions no-print">
          <button type="button" className="btn btn-secondary" onClick={() => window.print()}>Print</button>
          <CopyButton value={kit} label="Secret key" />
        </div>
        <Check checked={saved} onChange={setSaved}>I have stored my Emergency Kit somewhere safe.</Check>
        <div className="settings-actions no-print">
          <button className="btn btn-primary" disabled={!saved} onClick={() => { setKit(''); setSaved(false); setMode('idle') }}><IconCheck size={16} />Done</button>
        </div>
      </section>
    )
  }

  return (
    <form className="settings-card" onSubmit={submit} aria-labelledby="s-secret">
      <div className="settings-card-head"><IconKey size={18} /><h2 id="s-secret">Secret key</h2>{on ? <span className="pill pill-ok">On</span> : null}</div>
      <p className="muted small">
        {on
          ? 'Your master password works only together with a secret key that never leaves your devices. Even someone with a full copy of the server cannot guess your password. Each new browser asks for it once.'
          : 'Optional. Adds a 128-bit secret key, kept on your devices, to your master password, so a copy of the server alone cannot be used to guess your password. Each new browser will ask for it once, from your Emergency Kit.'}
      </p>
      {mode === 'idle' ? (
        <div className="settings-actions">
          {on ? <>
            <button type="button" className="btn btn-secondary" onClick={() => setMode('show')}>Show Emergency Kit</button>
            <button type="button" className="btn btn-ghost" onClick={() => setMode('remove')}>Remove the secret key</button>
          </> : <button type="button" className="btn btn-secondary" onClick={() => setMode('add')}>Add a secret key</button>}
        </div>
      ) : (
        <>
          {mode === 'remove' ? <p className="alert alert-warn"><IconAlert size={16} /><span>Your master password alone will open the account again. Other devices are signed out.</span></p> : null}
          {mode === 'add' ? <p className="hint">Other devices are signed out; they need the secret key to sign in again. If you ever lose it, your recovery key still gets you in.</p> : null}
          <div className="field">
            <label htmlFor="sk-password">Master password</label>
            <PasswordInput id="sk-password" autoComplete="current-password" required value={password} onChange={setPassword} />
          </div>
          {error ? <p className="alert alert-error"><IconAlert size={16} />{error}</p> : null}
          <div className="settings-actions">
            <button type="button" className="btn btn-ghost" onClick={() => { setMode('idle'); setPassword(''); setError('') }}>Cancel</button>
            <button className="btn btn-primary" type="submit" disabled={busy || !password}>
              {busy ? <span className="spinner" /> : null}{mode === 'add' ? 'Add a secret key' : mode === 'remove' ? 'Remove it' : 'Show'}
            </button>
          </div>
        </>
      )}
    </form>
  )
}

/** The printable page: where, who, the secret key, and a blank line for the
 *  master password, which Vault never writes down for you. */
export function EmergencyKit({ email, secretKey }: { email: string; secretKey: string }) {
  return (
    <div className="emergency-kit" aria-label="Emergency Kit">
      <p className="kit-title">Vault Emergency Kit</p>
      <dl>
        <dt>Server</dt><dd><code>{location.origin}</code></dd>
        <dt>Email</dt><dd>{email}</dd>
        <dt>Secret key</dt><dd><code className="kit-secret">{secretKey}</code></dd>
        <dt>Master password</dt><dd className="kit-blank" aria-label="Write your master password here, by hand" />
      </dl>
      <p className="muted small">Made {new Date().toLocaleDateString()}. Keep it somewhere safe, away from this device. Anyone with this page and your master password can open your vault.</p>
    </div>
  )
}
