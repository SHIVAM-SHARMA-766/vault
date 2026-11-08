// Passkeys and security keys as a second factor (D9, decisions/0022). Adding
// one re-proves the master password; removing one also needs a second factor,
// which can be another key, the authenticator app or a recovery code.

import { useState } from 'react'

import { ApiError, type SecondFactor, type SecondFactorOffer, api } from '../../lib/api.js'
import { when } from '../../lib/format.js'
import * as session from '../../lib/session.js'
import { createCredential, getAssertion, webauthnSupported } from '../../lib/webauthn.js'
import { IconAlert, IconKey } from '../../ui/icons.js'
import { CopyButton, PasswordInput, useToast } from '../../ui/kit.js'
import { proveCurrent } from './prove.js'
import type { TwoFactorStatus } from './TwoFactor.js'

export function SecurityKeys({ state, status, reload }: { state: session.Unlocked; status: TwoFactorStatus | null; reload: () => void }) {
  const toast = useToast()
  const [step, setStep] = useState<{ kind: 'idle' } | { kind: 'add' } | { kind: 'remove'; id: string; name: string } | { kind: 'codes'; codes: string[] }>({ kind: 'idle' })
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const keys = status?.keys ?? []
  const reset = () => { setStep({ kind: 'idle' }); setPassword(''); setName(''); setCode(''); setError('') }

  if (!webauthnSupported()) return null

  async function add(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      const authKey = await proveCurrent(state, password)
      const { options } = await api.twoFactor.keyOptions(await session.token(), authKey)
      const response = await createCredential(options)
      const r = await api.twoFactor.addKey(await session.token(), name.trim() || 'Security key', response)
      toast(`${r.name} added`)
      reload()
      if (r.recoveryCodes) setStep({ kind: 'codes', codes: r.recoveryCodes }); else reset()
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'invalid_credentials' ? 'The master password is wrong.'
        : err instanceof DOMException ? 'The browser or the key cancelled. Try again.'
        : err instanceof Error ? err.message : 'Could not add the key.')
    } finally { setBusy(false) }
  }

  async function remove(e: React.FormEvent, id: string) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      const authKey = await proveCurrent(state, password)
      const typed = code.replace(/\s/g, '')
      let second: SecondFactor | undefined = typed ? (/^\d{6}$/.test(typed) ? { totpCode: typed } : { recoveryCode: code.trim() }) : undefined
      try {
        await api.twoFactor.removeKey(await session.token(), id, authKey, second)
      } catch (err) {
        // Without a typed code, prove a second factor with a key now.
        const offer = err instanceof ApiError && err.code === 'two_factor_required' ? (err.details as SecondFactorOffer | undefined) : undefined
        if (!offer?.webauthn || second) throw err
        second = { webauthn: await getAssertion(offer.webauthn) }
        await api.twoFactor.removeKey(await session.token(), id, authKey, second)
      }
      toast('Key removed')
      reset(); reload()
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'invalid_credentials' ? 'The master password is wrong.'
        : err instanceof ApiError ? err.message : err instanceof DOMException ? 'The key did not answer.' : 'Could not remove the key.')
    } finally { setBusy(false) }
  }

  return (
    <section className="settings-card" aria-labelledby="s-keys">
      <div className="settings-card-head"><IconKey size={18} /><h2 id="s-keys">Passkeys and security keys</h2>
        {status ? <span className={`pill ${keys.length ? 'pill-ok' : ''}`}>{keys.length ? `${keys.length} added` : 'None'}</span> : null}</div>
      <p className="muted small">A hardware key (YubiKey, Titan) or a passkey on this device (Windows Hello, Touch ID, Android) as a second factor at sign-in. It cannot be phished: it only answers this server&apos;s address. Your master password still unlocks the vault.</p>
      {keys.length ? (
        <ul className="device-list">
          {keys.map((k) => (
            <li key={k.id} className="device-row">
              <div className="device-text"><span className="device-name">{k.name}</span>
                <span className="muted small">added {when(k.createdAt)}{k.lastUsedAt ? ` · last used ${when(k.lastUsedAt)}` : ''}</span></div>
              <div className="device-actions"><button className="btn btn-danger-ghost btn-sm" aria-label={`Remove ${k.name}`} onClick={() => setStep({ kind: 'remove', id: k.id, name: k.name })}>Remove</button></div>
            </li>
          ))}
        </ul>
      ) : null}

      {step.kind === 'idle' ? (
        <div className="settings-actions"><button className="btn btn-secondary" disabled={!status} onClick={() => setStep({ kind: 'add' })}>Add a passkey or security key</button></div>
      ) : step.kind === 'add' ? (
        <form onSubmit={add}>
          <div className="grid-2">
            <div className="field"><label htmlFor="key-pw">Master password</label><PasswordInput id="key-pw" autoComplete="current-password" required value={password} onChange={setPassword} /></div>
            <div className="field"><label htmlFor="key-name">Name it</label><input id="key-name" maxLength={40} placeholder="e.g. YubiKey, work laptop" value={name} onChange={(e) => setName(e.target.value)} /></div>
          </div>
          {error ? <p className="alert alert-error"><IconAlert size={16} />{error}</p> : null}
          <div className="settings-actions">
            <button type="button" className="btn btn-secondary" onClick={reset}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy || !password}>{busy ? <span className="spinner" /> : null}Continue</button>
          </div>
        </form>
      ) : step.kind === 'remove' ? (
        <form onSubmit={(e) => void remove(e, step.id)}>
          <p><strong>Remove {step.name}?</strong> Prove it is you: your master password, then a key, or a code from your authenticator app or a recovery code.</p>
          <div className="grid-2">
            <div className="field"><label htmlFor="rk-pw">Master password</label><PasswordInput id="rk-pw" autoComplete="current-password" required value={password} onChange={setPassword} /></div>
            <div className="field"><label htmlFor="rk-code">Code (optional: leave empty to use a key)</label><input id="rk-code" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} /></div>
          </div>
          {error ? <p className="alert alert-error"><IconAlert size={16} />{error}</p> : null}
          <div className="settings-actions">
            <button type="button" className="btn btn-secondary" onClick={reset}>Cancel</button>
            <button type="submit" className="btn btn-danger" disabled={busy || !password}>{busy ? <span className="spinner" /> : null}Remove</button>
          </div>
        </form>
      ) : (
        <div>
          <p className="alert alert-warn"><IconAlert size={16} /><span>Save these recovery codes somewhere safe. Each works once, if you lose your keys. They are shown only now.</span></p>
          <ul className="codes">{step.codes.map((c) => <li key={c}><code>{c}</code></li>)}</ul>
          <div className="settings-actions"><CopyButton value={step.codes.join('\n')} label="Recovery codes" /><button className="btn btn-primary" onClick={reset}>I have saved them</button></div>
        </div>
      )}
    </section>
  )
}
