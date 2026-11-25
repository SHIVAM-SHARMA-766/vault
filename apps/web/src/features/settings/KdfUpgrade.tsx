// Upgrade key derivation (decisions/0028): an account made before Argon2id
// re-derives with it, keeping the same master password. The vault key is
// re-wrapped, as in a password change; no item is touched.

import { useEffect, useState } from 'react'

import { ARGON2_DEFAULT, argon2Supported, changePassword, kdfIsOutdated } from '@vault/crypto'

import { ApiError, api } from '../../lib/api.js'
import { secretKeyFor } from '../../lib/secretkey.js'
import * as session from '../../lib/session.js'
import { IconAlert, IconShield } from '../../ui/icons.js'
import { PasswordInput, useToast } from '../../ui/kit.js'
import { proveCurrent } from './prove.js'

export function KdfUpgrade({ state }: { state: session.Unlocked }) {
  const toast = useToast()
  const [supported, setSupported] = useState(false)
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { void argon2Supported().then(setSupported) }, [])

  if (!supported || !kdfIsOutdated(state.kdf)) return null

  async function upgrade(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      const currentAuthKey = await proveCurrent(state, password)
      const sk = await secretKeyFor(state.email, state.kdf)
      const changed = await changePassword(password, state.vaultKey, ARGON2_DEFAULT, sk)
      sk?.fill(0)
      const res = await api.changePassword(await session.token(), {
        currentAuthKey, newAuthKey: changed.authKey, kdf: changed.kdf, wrappedVaultKey: changed.wrappedVaultKey, purpose: 'upgrade-kdf',
      })
      session.patch({ kdf: changed.kdf, accessToken: res.accessToken, refreshToken: res.refreshToken, accessExpiresAt: session.expiresAtFrom(res) })
      toast('Key derivation upgraded to Argon2id')
      setOpen(false); setPassword('')
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'invalid_credentials' ? 'The master password is wrong.'
        : err instanceof Error ? err.message : 'Could not upgrade.')
    } finally { setBusy(false) }
  }

  return (
    <section className="settings-card" aria-labelledby="s-kdf">
      <div className="settings-card-head"><IconShield size={18} /><h2 id="s-kdf">Upgrade key derivation</h2><span className="pill pill-warn">PBKDF2</span></div>
      <p className="muted small">Your master password is stretched with PBKDF2, from before Vault used <strong>Argon2id</strong>. Argon2id needs 64 MiB of memory for every guess, which makes guessing on graphics cards and custom chips far slower. Upgrading keeps the same master password and re-wraps your vault key in this browser. Your other devices are signed out.</p>
      {open ? (
        <form onSubmit={(e) => void upgrade(e)}>
          <div className="field"><label htmlFor="kdf-pw">Master password</label><PasswordInput id="kdf-pw" autoComplete="current-password" required value={password} onChange={setPassword} /></div>
          {error ? <p className="alert alert-error"><IconAlert size={16} />{error}</p> : null}
          <div className="settings-actions">
            <button type="button" className="btn btn-secondary" onClick={() => { setOpen(false); setError('') }}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy || !password}>{busy ? <span className="spinner" /> : null}Upgrade</button>
          </div>
        </form>
      ) : <div className="settings-actions"><button className="btn btn-primary" onClick={() => setOpen(true)}>Upgrade to Argon2id</button></div>}
    </section>
  )
}
