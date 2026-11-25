// Unlock with a passkey (decisions/0034). Opt-in, per passkey: each one is a
// key to the whole vault, so the card says that plainly. Adding one re-proves
// the master password; removing one needs only this session.

import { useEffect, useState } from 'react'

import { ApiError, api } from '../../lib/api.js'
import { when } from '../../lib/format.js'
import { NoPrfError, enrolPasskey, passkeysOffered } from '../../lib/passkey.js'
import * as session from '../../lib/session.js'
import { IconAlert, IconFingerprint } from '../../ui/icons.js'
import { PasswordInput, useToast } from '../../ui/kit.js'
import { proveCurrent } from './prove.js'

export type UnlockPasskey = { id: string; name: string; createdAt: string; lastUsedAt: string | null }

export function PasskeyUnlock({ state, passkeys, reload }: { state: session.Unlocked; passkeys: UnlockPasskey[] | null; reload: () => void }) {
  const toast = useToast()
  const [offered, setOffered] = useState(false)
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<UnlockPasskey | null>(null)
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { void passkeysOffered().then(setOffered) }, [])
  const reset = () => { setAdding(false); setRemoving(null); setPassword(''); setName(''); setError('') }

  if (!offered) return null
  const list = passkeys ?? []

  async function add(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      const authKey = await proveCurrent(state, password)
      const r = await enrolPasskey(state, authKey, name.trim() || 'Passkey')
      toast(`${r.name} can now unlock your vault`)
      reset(); reload()
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'invalid_credentials' ? 'The master password is wrong.'
        : err instanceof NoPrfError ? err.message
        : err instanceof DOMException ? 'The browser or the passkey cancelled. Try again.'
        : err instanceof Error ? err.message : 'Could not add the passkey.')
    } finally { setBusy(false) }
  }

  async function remove(k: UnlockPasskey) {
    setBusy(true); setError('')
    try {
      await api.passkeys.remove(await session.token(), k.id)
      toast(`${k.name} no longer unlocks your vault`)
      reset(); reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove the passkey.')
    } finally { setBusy(false) }
  }

  return (
    <section className="settings-card" aria-labelledby="s-passkeys">
      <div className="settings-card-head"><IconFingerprint size={18} /><h2 id="s-passkeys">Unlock with a passkey</h2>
        {passkeys ? <span className={`pill ${list.length ? 'pill-ok' : ''}`}>{list.length ? `${list.length} added` : 'Off'}</span> : null}</div>
      <p className="muted small">Sign in with Touch ID, Windows Hello, your phone or a security key instead of typing your master password. The passkey opens the vault in this browser; the server never sees what unlocks it. Your master password keeps working.</p>
      {list.length ? (
        <ul className="device-list">
          {list.map((k) => (
            <li key={k.id} className="device-row">
              <div className="device-text"><span className="device-name">{k.name}</span>
                <span className="muted small">added {when(k.createdAt)}{k.lastUsedAt ? ` · last used ${when(k.lastUsedAt)}` : ' · not used yet'}</span></div>
              <div className="device-actions">
                {removing?.id === k.id ? (
                  <>
                    <button className="btn btn-secondary btn-sm" onClick={reset} disabled={busy}>Keep</button>
                    <button className="btn btn-danger btn-sm" onClick={() => void remove(k)} disabled={busy}>{busy ? <span className="spinner" /> : null}Remove</button>
                  </>
                ) : <button className="btn btn-danger-ghost btn-sm" aria-label={`Stop ${k.name} unlocking`} onClick={() => { setAdding(false); setRemoving(k) }}>Remove</button>}
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {adding ? (
        <form onSubmit={(e) => void add(e)}>
          <p className="alert alert-warn"><IconAlert size={16} /><span>Anyone who can use this passkey (your device and its PIN or fingerprint) can open your vault without the master password. Add only passkeys on devices you alone use.</span></p>
          <div className="grid-2">
            <div className="field"><label htmlFor="pk-pw">Master password</label><PasswordInput id="pk-pw" autoComplete="current-password" required value={password} onChange={setPassword} /></div>
            <div className="field"><label htmlFor="pk-name">Name it</label><input id="pk-name" maxLength={40} placeholder="e.g. MacBook Touch ID, Pixel" value={name} onChange={(e) => setName(e.target.value)} /></div>
          </div>
          {error ? <p className="alert alert-error"><IconAlert size={16} />{error}</p> : null}
          <div className="settings-actions">
            <button type="button" className="btn btn-secondary" onClick={reset}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy || !password}>{busy ? <span className="spinner" /> : null}Add passkey</button>
          </div>
        </form>
      ) : (
        <>
          {error ? <p className="alert alert-error"><IconAlert size={16} />{error}</p> : null}
          <div className="settings-actions"><button className="btn btn-secondary" disabled={!passkeys} onClick={() => { setRemoving(null); setAdding(true) }}>Add a passkey to unlock</button></div>
        </>
      )}
    </section>
  )
}
