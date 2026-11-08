// Two-factor sign-in settings: turn on with an authenticator app (QR code or
// key typed in), keep recovery codes, issue new ones, turn off. Every change
// re-proves the master password, and turning off or replacing codes also
// needs a current code — checked by the server (decisions/0011).

import { useMemo, useState } from 'react'

import { encodeQr, qrPath } from '@vault/core'

import { ApiError, type SecondFactor, api } from '../../lib/api.js'
import * as session from '../../lib/session.js'
import { IconAlert, IconCheck, IconCopy, IconShield } from '../../ui/icons.js'
import { Check, PasswordInput, useToast } from '../../ui/kit.js'
import { proveCurrent } from './prove.js'

export interface TwoFactorStatus {
  /** Any second factor: the authenticator app or a key. */
  enabled: boolean
  /** The authenticator app (TOTP) in particular. */
  totp?: boolean
  recoveryCodesLeft: number
  keys?: { id: string; name: string; createdAt: string; lastUsedAt: string | null }[]
}

type View =
  | { kind: 'idle' }
  | { kind: 'password'; then: 'setup' | 'disable' | 'codes' }
  | { kind: 'scan'; secret: string }
  | { kind: 'codes'; codes: string[] }

export function TwoFactor({ state, status, reload }: { state: session.Unlocked; status: TwoFactorStatus | null; reload: () => void }) {
  const toast = useToast()
  const [view, setView] = useState<View>({ kind: 'idle' })
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const reset = () => { setView({ kind: 'idle' }); setPassword(''); setCode(''); setError('') }
  // The app in particular; keys have their own card (SecurityKeys).
  const app = status ? (status.totp ?? status.enabled) : false

  function explain(err: unknown) {
    setError(err instanceof ApiError && err.status === 401 && err.code === 'invalid_credentials' ? 'The master password is wrong.'
      : err instanceof ApiError && err.code === 'invalid_two_factor' ? err.message
      : err instanceof Error ? err.message : 'That did not work.')
  }

  async function withPassword(then: 'setup' | 'disable' | 'codes') {
    setError('')
    setBusy(true)
    try {
      const authKey = await proveCurrent(state, password)
      const second: SecondFactor = code.replace(/\s/g, '').length === 6 && /^\d+$/.test(code.replace(/\s/g, ''))
        ? { totpCode: code.replace(/\s/g, '') } : { recoveryCode: code.trim() }
      if (then === 'setup') {
        const { secret } = await api.twoFactor.setup(await session.token(), authKey)
        setView({ kind: 'scan', secret })
      } else if (then === 'disable') {
        await api.twoFactor.disable(await session.token(), authKey, second)
        toast('Two-factor sign-in is off')
        reset()
        reload()
      } else {
        const { recoveryCodes } = await api.twoFactor.recoveryCodes(await session.token(), authKey, second)
        setView({ kind: 'codes', codes: recoveryCodes })
        reload()
      }
      setPassword('')
      setCode('')
    } catch (err) {
      explain(err)
    } finally {
      setBusy(false)
    }
  }

  async function confirmScan() {
    setError('')
    setBusy(true)
    try {
      const { recoveryCodes } = await api.twoFactor.enable(await session.token(), code.replace(/\s/g, ''))
      setCode('')
      setView({ kind: 'codes', codes: recoveryCodes })
      reload()
    } catch (err) {
      explain(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="settings-card" aria-labelledby="s-2fa">
      <div className="settings-card-head">
        <IconShield size={18} /><h2 id="s-2fa">Authenticator app</h2>
        {status ? <span className={`pill ${app ? 'pill-ok' : ''}`}>{app ? 'On' : 'Off'}</span> : null}
      </div>

      {view.kind === 'idle' ? (
        <>
          <p className="muted small">
            {app
              ? `Signing in can use a code from your authenticator app. ${status!.recoveryCodesLeft} recovery code${status!.recoveryCodesLeft === 1 ? '' : 's'} left.`
              : 'Ask for a code from an authenticator app (such as Aegis, Google Authenticator or 2FAS) as well as your master password when signing in. Someone who learns your password still cannot get in.'}
          </p>
          {status?.enabled && status.recoveryCodesLeft <= 3 ? (
            <p className="alert alert-warn"><IconAlert size={16} /><span>You are running low on recovery codes. Issue new ones.</span></p>
          ) : null}
          <div className="settings-actions">
            {app ? (
              <>
                <button className="btn btn-secondary" onClick={() => setView({ kind: 'password', then: 'codes' })}>New recovery codes</button>
                <button className="btn btn-danger-ghost" onClick={() => setView({ kind: 'password', then: 'disable' })}>Turn off</button>
              </>
            ) : (
              <button className="btn btn-primary" disabled={!status} onClick={() => setView({ kind: 'password', then: 'setup' })}>Turn on</button>
            )}
          </div>
        </>
      ) : null}

      {view.kind === 'password' ? (
        <form onSubmit={(e) => { e.preventDefault(); void withPassword(view.then) }}>
          <p className="muted small">
            {view.then === 'setup' ? 'Confirm it is you to begin.'
              : view.then === 'disable' ? 'Turning it off needs your master password and a current code.'
              : 'New codes replace all the old ones. Confirm with your master password and a current code.'}
          </p>
          <div className="field">
            <label htmlFor="tf-password">Master password</label>
            <PasswordInput id="tf-password" autoComplete="current-password" required autoFocus value={password} onChange={setPassword} />
          </div>
          {view.then !== 'setup' ? (
            <div className="field">
              <label htmlFor="tf-current">Code from your app, or a recovery code</label>
              <input id="tf-current" autoComplete="one-time-code" spellCheck={false} required value={code} onChange={(e) => setCode(e.target.value)} />
            </div>
          ) : null}
          {error ? <p className="alert alert-error"><IconAlert size={16} />{error}</p> : null}
          <div className="settings-actions">
            <button type="button" className="btn btn-secondary" onClick={reset}>Cancel</button>
            <button type="submit" className={`btn ${view.then === 'disable' ? 'btn-danger' : 'btn-primary'}`} disabled={busy || !password || (view.then !== 'setup' && !code)}>
              {busy ? <span className="spinner" /> : null}{view.then === 'setup' ? 'Continue' : view.then === 'disable' ? 'Turn off' : 'Issue new codes'}
            </button>
          </div>
        </form>
      ) : null}

      {view.kind === 'scan' ? (
        <Scan secret={view.secret} email={state.email} code={code} setCode={setCode} busy={busy} error={error}
              onConfirm={confirmScan} onCancel={reset} />
      ) : null}

      {view.kind === 'codes' ? <RecoveryCodes codes={view.codes} onDone={reset} /> : null}
    </section>
  )
}

function Scan({ secret, email, code, setCode, busy, error, onConfirm, onCancel }: {
  secret: string; email: string; code: string; setCode: (v: string) => void
  busy: boolean; error: string; onConfirm: () => void; onCancel: () => void
}) {
  // The label names this server, because a self-hosted Vault can be one of
  // several in the same app.
  const issuer = `Vault (${location.hostname})`
  const uri = `otpauth://totp/${encodeURIComponent(`${issuer}:${email}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
  const qr = useMemo(() => encodeQr(uri, 'M'), [uri])
  const quiet = 4
  return (
    <form onSubmit={(e) => { e.preventDefault(); onConfirm() }}>
      <ol className="steps-list">
        <li>Scan this with your authenticator app, or type the key in.</li>
        <li>Enter the six-digit code it shows.</li>
      </ol>
      <div className="scan">
        <svg className="qr" viewBox={`0 0 ${qr.size + quiet * 2} ${qr.size + quiet * 2}`} role="img" aria-label="QR code for your authenticator app" shapeRendering="crispEdges">
          <rect width="100%" height="100%" fill="#fff" />
          <path d={qrPath(qr, quiet)} fill="#000" />
        </svg>
        <div className="scan-side">
          <span className="field-label">Key, if you cannot scan</span>
          <code className="secret-key">{secret.match(/.{1,4}/g)?.join(' ')}</code>
          <div className="field">
            <label htmlFor="tf-new">Six-digit code</label>
            <input id="tf-new" className="code-input" inputMode="numeric" autoComplete="one-time-code" autoFocus
                   placeholder="123 456" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} />
          </div>
        </div>
      </div>
      {error ? <p className="alert alert-error"><IconAlert size={16} />{error}</p> : null}
      <div className="settings-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={busy || !/^\d{6}$/.test(code.replace(/\s/g, ''))}>
          {busy ? <span className="spinner" /> : null}Turn on
        </button>
      </div>
    </form>
  )
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const toast = useToast()
  const [saved, setSaved] = useState(false)
  const text = `Vault recovery codes for ${location.hostname}\nEach code works once.\n\n${codes.join('\n')}\n`
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'vault-recovery-codes.txt'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }
  return (
    <div>
      <p className="alert alert-warn"><IconAlert size={16} /><span>Save these now — they are shown once. Each lets you sign in once without your phone.</span></p>
      <ul className="codes">{codes.map((c) => <li key={c}><code>{c}</code></li>)}</ul>
      <div className="settings-actions settings-actions-left">
        <button type="button" className="btn btn-secondary btn-sm" onClick={async () => {
          try { await navigator.clipboard.writeText(text); toast('Recovery codes copied') } catch { toast('The browser refused clipboard access', 'error') }
        }}><IconCopy size={15} />Copy</button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={download}>Download .txt</button>
      </div>
      <Check checked={saved} onChange={setSaved}>I have saved these recovery codes somewhere safe.</Check>
      <div className="settings-actions">
        <button className="btn btn-primary" disabled={!saved} onClick={onDone}><IconCheck size={16} />Done</button>
      </div>
    </div>
  )
}
