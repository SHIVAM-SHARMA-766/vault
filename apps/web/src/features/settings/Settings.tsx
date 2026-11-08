// Account settings, in sections with their own addresses (/app/settings,
// /app/settings/security, …): the account and its keys, sign-in security,
// preferences, and emergency access. Every change that weakens the account's
// hold on itself asks for the current master password again, and the server
// checks that proof (services/api/src/routes/auth.ts).

import { useEffect, useState } from 'react'

import { belowMinimum, passwordStrength } from '@vault/core'
import { changePassword, fromBase64Url, identityFingerprint, rotateRecoveryKey } from '@vault/crypto'

import { ApiError, api } from '../../lib/api.js'
import * as session from '../../lib/session.js'
import { href, navigate } from '../../lib/router.js'
import { IconAlert, IconCheck, IconDownload, IconKey, IconLock, IconShield, IconSliders, IconUser, IconUsers } from '../../ui/icons.js'
import { Check, CopyButton, PasswordInput, StrengthMeter, useToast } from '../../ui/kit.js'
import { Shell } from '../../ui/Shell.js'
import { proveCurrent } from './prove.js'
import { Activity, Devices } from './Devices.js'
import { Backups } from './Backups.js'
import { DeleteAccount } from './DeleteAccount.js'
import { Emergency } from './Emergency.js'
import { ShareLinks } from './ShareLinks.js'
import { Preferences } from './Preferences.js'
import { TwoFactor, type TwoFactorStatus } from './TwoFactor.js'

const MIN_LENGTH = 12

const TABS = [
  { id: 'account', label: 'Account', Icon: IconUser, intro: 'Your sign-in details, master password and keys.' },
  { id: 'security', label: 'Security', Icon: IconShield, intro: 'Two-factor sign-in, the devices signed in to your account, and recent activity.' },
  { id: 'preferences', label: 'Preferences', Icon: IconSliders, intro: 'How Vault looks and behaves. Saved encrypted, so they follow you to every device.' },
  { id: 'backups', label: 'Backups', Icon: IconDownload, intro: 'Your own encrypted backups, on your schedule, kept here or in your own storage.' },
  { id: 'emergency', label: 'Emergency access', Icon: IconUsers, intro: 'People you trust to reach your vault if something happens to you.' },
] as const
type Tab = (typeof TABS)[number]['id']

export function Settings({ state, tab: requested }: { state: session.Unlocked; tab: string | null }) {
  const [me, setMe] = useState<{ createdAt: string; fingerprint: string | null; twoFactor: TwoFactorStatus; policy: { minPasswordScore: number }; policyGap: string | null } | null>(null)
  const [version, setVersion] = useState(0)
  const tab: Tab = TABS.find((t) => t.id === requested)?.id ?? 'account'
  const info = TABS.find((t) => t.id === tab)!
  const go = (t: Tab) => navigate(href({ name: 'settings', tab: t === 'account' ? null : t }))

  useEffect(() => {
    void (async () => {
      try {
        const info = await api.me(await session.token())
        const fingerprint = info.identity ? await identityFingerprint(fromBase64Url(info.identity.publicKey)) : null
        setMe({ createdAt: info.createdAt, fingerprint, twoFactor: info.twoFactor, policy: info.policy, policyGap: info.policyGap })
        // Turning on two-factor here may close a policy gap; the vault's
        // banner follows.
        session.patch({ policyGap: info.policyGap })
      } catch { /* sections that need it say so */ }
    })()
  }, [version])

  return (
    <Shell state={state}>
      <div className="admin-layout">
        <nav className="sidebar" aria-label="Settings sections">
          {TABS.map(({ id, label, Icon }) => (
            <button key={id} className={`side-item ${tab === id ? 'side-active' : ''}`} onClick={() => go(id)} aria-current={tab === id ? 'page' : undefined}>
              <Icon size={16} /><span>{label}</span>
            </button>
          ))}
          <div className="sidebar-foot">
            <IconLock size={14} /> Changes are made in this browser and proved to the server. Your master password and keys never leave it.
          </div>
        </nav>

        <div className="filter-chips admin-chips">
          {TABS.map(({ id, label }) => (
            <button key={id} className={`chip ${tab === id ? 'chip-active' : ''}`} onClick={() => go(id)}>{label}</button>
          ))}
        </div>

        <main className="settings">
          <div className="settings-head">
            <h1>{info.label}</h1>
            <p className="muted">{info.intro}</p>
          </div>

          {me?.policyGap ? <p className="alert alert-warn"><IconAlert size={16} /><span>{me.policyGap}</span></p> : null}

          {tab === 'account' ? <>
            <section className="settings-card" aria-labelledby="s-account">
              <div className="settings-card-head"><IconUser size={18} /><h2 id="s-account">Account</h2></div>
              <dl className="facts">
                <div><dt>Email</dt><dd>{state.email}</dd></div>
                <div><dt>Role</dt><dd>{state.role && state.role !== 'user' ? state.role[0]!.toUpperCase() + state.role.slice(1) : 'Member'}</dd></div>
                <div><dt>Created</dt><dd>{me ? new Date(me.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—'}</dd></div>
              </dl>
            </section>
            <ChangePassword state={state} minScore={me?.policy.minPasswordScore ?? 0} />
            <RotateRecovery state={state} />
            <section className="settings-card" aria-labelledby="s-identity">
              <div className="settings-card-head"><IconShield size={18} /><h2 id="s-identity">Identity key</h2></div>
              <p className="muted small">
                When someone shares with you, they encrypt to this key. If they ever want to check it really is
                yours, compare this fingerprint with them over a channel you trust — in person or on a call.
              </p>
              <div className="fingerprint">
                {me?.fingerprint ? <code>{me.fingerprint}</code> : <span className="muted">{me ? 'Being created — unlock again to see it.' : 'Loading…'}</span>}
                {me?.fingerprint ? <CopyButton value={me.fingerprint} label="Fingerprint" /> : null}
              </div>
            </section>
            <DeleteAccount state={state} twoFactor={me?.twoFactor.enabled ?? false} />
          </> : null}

          {tab === 'security' ? <>
            <TwoFactor state={state} status={me?.twoFactor ?? null} reload={() => setVersion((v) => v + 1)} />
            <Devices />
            <ShareLinks vaultKey={state.vaultKey} />
            <Activity />
          </> : null}

          {tab === 'preferences' ? <Preferences state={state} /> : null}
          {tab === 'backups' ? <Backups /> : null}
          {tab === 'emergency' ? <Emergency state={state} /> : null}
        </main>
      </div>
    </Shell>
  )
}

function ChangePassword({ state, minScore }: { state: session.Unlocked; minScore: number }) {
  const toast = useToast()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (next.length < MIN_LENGTH) return setError(`The new master password must be at least ${MIN_LENGTH} characters.`)
    const weak = belowMinimum(next, minScore)
    if (weak) return setError(weak)
    if (next !== confirm) return setError('The new passwords do not match.')
    if (next === current) return setError('The new master password is the same as the current one.')
    setBusy(true)
    try {
      const currentAuthKey = await proveCurrent(state, current)
      // Only the vault key is rewrapped. No entry is re-encrypted (decisions/0001).
      const changed = await changePassword(next, state.vaultKey)
      const res = await api.changePassword(await session.token(), {
        currentAuthKey, newAuthKey: changed.authKey, kdf: changed.kdf, wrappedVaultKey: changed.wrappedVaultKey,
      })
      session.patch({
        kdf: changed.kdf, accessToken: res.accessToken, refreshToken: res.refreshToken,
        accessExpiresAt: session.expiresAtFrom(res),
      })
      void api.passwordScore(res.accessToken, passwordStrength(next).score).catch(() => {})
      setCurrent(''); setNext(''); setConfirm('')
      toast('Master password changed. Other devices have been signed out.')
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? 'The current master password is wrong.'
        : err instanceof Error ? err.message : 'Could not change the master password.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="settings-card" onSubmit={submit} aria-labelledby="s-password">
      <div className="settings-card-head"><IconLock size={18} /><h2 id="s-password">Master password</h2></div>
      <p className="muted small">Changing it signs out every other device. Your entries are not re-encrypted, so it takes a moment, not minutes.</p>
      <div className="field">
        <label htmlFor="cp-current">Current master password</label>
        <PasswordInput id="cp-current" autoComplete="current-password" required value={current} onChange={setCurrent} />
      </div>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="cp-new">New master password</label>
          <PasswordInput id="cp-new" autoComplete="new-password" required value={next} onChange={setNext} />
          <StrengthMeter password={next} />
        </div>
        <div className="field">
          <label htmlFor="cp-confirm">Confirm new master password</label>
          <PasswordInput id="cp-confirm" autoComplete="new-password" required value={confirm} onChange={setConfirm} />
        </div>
      </div>
      {error ? <p className="alert alert-error"><IconAlert size={16} />{error}</p> : null}
      <div className="settings-actions">
        <button className="btn btn-primary" type="submit" disabled={busy || !current || !next || !confirm}>
          {busy ? <><span className="spinner" />Changing…</> : 'Change master password'}
        </button>
      </div>
    </form>
  )
}

function RotateRecovery({ state }: { state: session.Unlocked }) {
  const [current, setCurrent] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [issued, setIssued] = useState('')
  const [saved, setSaved] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const currentAuthKey = await proveCurrent(state, current)
      const next = await rotateRecoveryKey(state.vaultKey)
      await api.rotateRecovery(await session.token(), {
        currentAuthKey, recoveryAuthKey: next.recoveryAuthKey, wrappedVaultKeyForRecovery: next.wrappedVaultKeyForRecovery,
      })
      setIssued(next.recoveryKey)
      setCurrent('')
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? 'The master password is wrong.'
        : err instanceof Error ? err.message : 'Could not issue a new recovery key.')
    } finally {
      setBusy(false)
    }
  }

  if (issued) {
    return (
      <section className="settings-card" aria-labelledby="s-recovery">
        <div className="settings-card-head"><IconKey size={18} /><h2 id="s-recovery">Your new recovery key</h2></div>
        <p className="alert alert-warn"><IconAlert size={16} /><span>The old recovery key no longer works. Store this one somewhere safe, off this device. It is shown once.</span></p>
        <div className="recovery-key"><code>{issued}</code><CopyButton value={issued} label="Recovery key" /></div>
        <Check checked={saved} onChange={setSaved}>I have stored the new recovery key somewhere safe.</Check>
        <div className="settings-actions">
          <button className="btn btn-primary" disabled={!saved} onClick={() => { setIssued(''); setSaved(false) }}><IconCheck size={16} />Done</button>
        </div>
      </section>
    )
  }

  return (
    <form className="settings-card" onSubmit={submit} aria-labelledby="s-recovery">
      <div className="settings-card-head"><IconKey size={18} /><h2 id="s-recovery">Recovery key</h2></div>
      <p className="muted small">
        The only way back in if you forget your master password. Issue a new one if the old one may have been
        seen, or if you have lost it while you still know your password. The old one stops working at once.
      </p>
      <div className="field">
        <label htmlFor="rk-current">Master password</label>
        <PasswordInput id="rk-current" autoComplete="current-password" required value={current} onChange={setCurrent} />
      </div>
      {error ? <p className="alert alert-error"><IconAlert size={16} />{error}</p> : null}
      <div className="settings-actions">
        <button className="btn btn-secondary" type="submit" disabled={busy || !current}>
          {busy ? <><span className="spinner" />Issuing…</> : 'Issue a new recovery key'}
        </button>
      </div>
    </form>
  )
}
