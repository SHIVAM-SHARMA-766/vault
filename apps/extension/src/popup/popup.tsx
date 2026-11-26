// The toolbar popup: choose the server, unlock, find an item, fill or copy.
// Everything secret stays in the background; the popup is handed a value only
// when the person copies it.

import { StrictMode, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { INLINE_ORIGINS, type ItemSummary, type SecondFactorInput, type StateReply, ask } from '../messages.js'

type Tab = { id: number; url: string } | null

async function activeTab(): Promise<Tab> {
  // Opened from the toolbar, the popup acts on the active tab. A test opens it
  // as a page and names the tab instead; the background checks that tab's URL
  // itself before filling, so the parameter grants nothing.
  const named = Number(new URLSearchParams(location.search).get('tab'))
  const tab = named ? await chrome.tabs.get(named) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0]
  return tab?.id && tab.url ? { id: tab.id, url: tab.url } : null
}

function App() {
  const [state, setState] = useState<StateReply | null>(null)
  const [error, setError] = useState('')
  const refresh = () => ask({ type: 'state' }).then(setState).catch((e: Error) => setError(e.message))
  useEffect(() => { void refresh() }, [])

  if (error) return <p className="alert" role="alert">{error}</p>
  if (!state) return <p className="muted pad">Loading…</p>
  if (!state.server) return <Setup onDone={refresh} />
  if (state.locked) return <Unlock state={state} onDone={refresh} />
  return <Vault state={state} onLock={refresh} />
}

function Setup({ onDone }: { onDone: () => void }) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    let origin: string
    try { origin = new URL(/^[a-z]+:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`).origin } catch { return setError('That is not a web address.') }
    setBusy(true)
    try {
      // Permission for this one origin, asked now, while the person is
      // looking at the address they typed.
      const granted = await chrome.permissions.request({ origins: [`${origin}/*`] })
      if (!granted) return setError('Without that permission the extension cannot reach your server.')
      const res = await ask({ type: 'setServer', url: origin })
      if (!res.ok) return setError(res.error)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally { setBusy(false) }
  }

  return (
    <form className="pad" onSubmit={submit}>
      <Brand />
      <h1>Connect to your Vault</h1>
      <p className="muted">The address you open Vault at, for example <code>https://vault.example.com</code>. The extension will ask to reach that address and no other.</p>
      <label htmlFor="server">Server address</label>
      <input id="server" type="url" inputMode="url" autoFocus required placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} />
      {error ? <p className="alert" role="alert">{error}</p> : null}
      <button className="primary block" type="submit" disabled={busy || !url.trim()}>{busy ? 'Connecting…' : 'Connect'}</button>
    </form>
  )
}

function Unlock({ state, onDone }: { state: StateReply; onDone: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [secretKey, setSecretKey] = useState('')
  const [needKey, setNeedKey] = useState(false)
  const [second, setSecond] = useState<string[] | null>(null)
  const [code, setCode] = useState('')
  const [useRecovery, setUseRecovery] = useState(false)
  const [refused, setRefused] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void chrome.storage.local.get('lastEmail').then((r) => { if (typeof r['lastEmail'] === 'string') setEmail(r['lastEmail']) })
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const recovery = useRecovery || (second !== null && !second.includes('totp'))
      const factor: SecondFactorInput | undefined = second && code.trim() ? (recovery ? { recoveryCode: code.trim() } : { totpCode: code.replace(/\s+/g, '') }) : undefined
      const res = await ask({ type: 'unlock', email, password, ...(secretKey.trim() ? { secretKey } : {}), ...(factor ? { second: factor } : {}) })
      if (res.ok) {
        await chrome.storage.local.set({ lastEmail: email.trim() })
        setPassword(''); setSecretKey(''); setCode('')
        onDone()
        return
      }
      setError(res.error)
      if (res.needSecretKey) setNeedKey(true)
      if (res.heldButRefused) setRefused(true)
      if (res.needSecond && res.needSecond.length) setSecond(res.needSecond)
      if (res.needSecond) setCode('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally { setBusy(false) }
  }

  const recoveryOnly = second !== null && !second.includes('totp')
  return (
    <form className="pad" onSubmit={submit}>
      <Brand name={state.serverName} />
      <h1>Unlock</h1>
      <label htmlFor="email">Email</label>
      <input id="email" type="email" autoComplete="username" required autoFocus={!email} value={email} onChange={(e) => { setEmail(e.target.value); setRefused(false) }} />
      <label htmlFor="password">Master password</label>
      <input id="password" type="password" autoComplete="current-password" required autoFocus={!!email} value={password} onChange={(e) => setPassword(e.target.value)} />
      {needKey ? <>
        <label htmlFor="secret-key">Secret key</label>
        <input id="secret-key" autoComplete="off" spellCheck={false} placeholder="SK1-XXXX-XXXX-…" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} />
      </> : null}
      {second ? <>
        <label htmlFor="code">{recoveryOnly || useRecovery ? 'Recovery code' : 'Authenticator code'}</label>
        <input id="code" autoComplete="one-time-code" inputMode={recoveryOnly || useRecovery ? 'text' : 'numeric'} autoFocus value={code} onChange={(e) => setCode(e.target.value)} />
        {!recoveryOnly ? <button type="button" className="link" onClick={() => setUseRecovery(!useRecovery)}>{useRecovery ? 'Use the authenticator app' : 'Use a recovery code instead'}</button> : null}
      </> : null}
      {error ? <p className="alert" role="alert">{error}</p> : null}
      {refused ? <button type="button" className="link" onClick={() => { void ask({ type: 'forgetSecretKey', email }).then(() => { setRefused(false); setError('') }) }}>I removed it — forget the secret key on this browser</button> : null}
      <button className="primary block" type="submit" disabled={busy || !email || !password}>{busy ? 'Unlocking…' : 'Unlock'}</button>
      <p className="foot muted small">
        Connected to <code>{state.server}</code> · <button type="button" className="link" onClick={() => { void ask({ type: 'forgetServer' }).then(onDone) }}>Change</button>
      </p>
    </form>
  )
}

function Vault({ state, onLock }: { state: StateReply; onLock: () => void }) {
  const [items, setItems] = useState<ItemSummary[] | null>(null)
  const [matches, setMatches] = useState<string[]>([])
  const [tab, setTab] = useState<Tab>(null)
  const [query, setQuery] = useState('')
  const [note, setNote] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const timer = useRef<number | undefined>(undefined)

  const flash = (text: string) => { setNote(text); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setNote(''), 2500) }
  const failed = (err: unknown) => {
    if ((err as { locked?: boolean }).locked) { onLock(); return }
    setError(err instanceof Error ? err.message : 'Something went wrong.')
  }

  async function load(sync = false) {
    try {
      const t = await activeTab()
      setTab(t)
      if (sync) await ask({ type: 'sync' })
      const res = await ask({ type: 'items', ...(t ? { pageUrl: t.url } : {}) })
      setItems(res.items); setMatches(res.matches); setNotice(res.notice ?? ''); setError('')
    } catch (err) { failed(err) }
  }
  useEffect(() => { void load() }, [])

  async function copy(item: ItemSummary, field: 'username' | 'password' | 'totp') {
    try {
      const { value } = await ask({ type: 'reveal', id: item.id, field })
      if (!value) return
      await navigator.clipboard.writeText(value)
      flash(field === 'totp' ? 'Code copied' : field === 'password' ? 'Password copied' : 'Username copied')
    } catch (err) { failed(err) }
  }

  async function fill(item: ItemSummary) {
    if (!tab) return
    try {
      const res = await ask({ type: 'fill', id: item.id, tabId: tab.id })
      if (res.error) setError(res.error)
      else window.close()
    } catch (err) { failed(err) }
  }

  const byId = useMemo(() => new Map((items ?? []).map((i) => [i.id, i])), [items])
  const suggested = matches.map((id) => byId.get(id)).filter((i): i is ItemSummary => !!i)
  const q = query.trim().toLowerCase()
  const shown = (items ?? []).filter((i) => !q || [i.name, i.username, i.host, i.where ?? ''].some((t) => t.toLowerCase().includes(q)))
  let pageHost = ''
  try { pageHost = tab ? new URL(tab.url).hostname : '' } catch { /* not a web page */ }

  return (
    <div className="vault">
      <header>
        <Brand name={state.serverName} />
        <div className="actions">
          <button type="button" className="ghost sm" title="Fetch the latest from the server" onClick={() => void load(true)}>Sync</button>
          <button type="button" className="ghost sm" onClick={() => { void ask({ type: 'lock' }).then(onLock) }}>Lock</button>
        </div>
      </header>
      <input className="search" type="search" placeholder="Search your vault" aria-label="Search your vault" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} />
      {error ? <p className="alert" role="alert">{error}</p> : null}
      {note ? <p className="note" role="status">{note}</p> : null}
      {notice ? <p className="warn" role="status">{notice}</p> : null}
      {items === null ? <p className="muted pad">Decrypting…</p> : <>
        {!q && pageHost ? (
          <section aria-label={`For ${pageHost}`}>
            <h2>For {pageHost}</h2>
            {suggested.length ? <ul>{suggested.map((i) => <Row key={i.id} item={i} onFill={() => void fill(i)} onCopy={(f) => void copy(i, f)} />)}</ul>
              : <p className="muted small pad-x">No saved login matches this site.</p>}
          </section>
        ) : null}
        <section aria-label="All items">
          <h2>{q ? `${shown.length} found` : 'All items'}</h2>
          {shown.length ? <ul>{shown.map((i) => <Row key={i.id} item={i} onCopy={(f) => void copy(i, f)} {...(matches.includes(i.id) ? { onFill: () => void fill(i) } : {})} />)}</ul>
            : <p className="muted small pad-x">{q ? 'Nothing matches.' : 'Your vault is empty.'}</p>}
        </section>
      </>}
      <InlineSetting on={state.inline} />
      <PasskeySetting on={state.passkeys} />
      <p className="foot muted small">Signed in as {state.email} · <a href={`${state.server}/app/`} target="_blank" rel="noreferrer">Open Vault</a></p>
    </div>
  )
}

/** Inside pages (stage 3): an icon in login fields, generate in sign-up
 *  forms, and save or update after signing in. It needs the optional
 *  all-sites permission, asked for here, when the person turns it on. */
function InlineSetting({ on: initial }: { on: boolean }) {
  const [on, setOn] = useState(initial)
  const [error, setError] = useState('')
  async function toggle(next: boolean) {
    setError('')
    try {
      if (next && !(await chrome.permissions.request({ origins: INLINE_ORIGINS }))) return setError('Without that permission it cannot work inside pages.')
      const res = await ask({ type: 'setInline', on: next })
      if (!res.ok) return setError(res.error)
      setOn(next)
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong.') }
  }
  return (
    <section className="setting" aria-label="Inside pages">
      <label className="check">
        <input type="checkbox" checked={on} onChange={(e) => void toggle(e.target.checked)} />
        <span>Show Vault in login fields and offer to save passwords</span>
      </label>
      <p className="muted small">{on ? 'Works on every site. Turning it off stops it; your browser\'s extension settings can also withdraw the permission.' : 'Asks your browser for access to the sites you visit. Off by default.'}</p>
      {error ? <p className="alert" role="alert">{error}</p> : null}
    </section>
  )
}

/** Passkeys in Vault (decisions/0035): Vault answers sites' passkey requests
 *  and keeps the passkeys in the vault. Same all-sites permission. */
function PasskeySetting({ on: initial }: { on: boolean }) {
  const [on, setOn] = useState(initial)
  const [error, setError] = useState('')
  async function toggle(next: boolean) {
    setError('')
    try {
      if (next && !(await chrome.permissions.request({ origins: INLINE_ORIGINS }))) return setError('Without that permission Vault cannot answer sites\' passkey requests.')
      const res = await ask({ type: 'setPasskeys', on: next })
      if (!res.ok) return setError(res.error)
      setOn(next)
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong.') }
  }
  return (
    <section className="setting" aria-label="Passkeys">
      <label className="check">
        <input type="checkbox" checked={on} onChange={(e) => void toggle(e.target.checked)} />
        <span>Save and use passkeys in Vault</span>
      </label>
      <p className="muted small">{on ? 'When a site offers a passkey, Vault asks to keep it, encrypted, on all your devices. You can always choose another device instead.' : 'Off: sites\' passkey requests go to your browser as usual.'}</p>
      {error ? <p className="alert" role="alert">{error}</p> : null}
    </section>
  )
}

function Row({ item, onFill, onCopy }: { item: ItemSummary; onFill?: () => void; onCopy: (field: 'username' | 'password' | 'totp') => void }) {
  return (
    <li className="row" aria-label={item.name}>
      <div className="row-main">
        <strong>{item.name}</strong>
        <span className="muted small">{item.username || item.host || '—'}</span>
        {item.where ? <span className="where" title="Shared collection">{item.where}</span> : null}
      </div>
      <div className="row-actions">
        {onFill ? <button type="button" className="primary sm" onClick={onFill}>Fill</button> : null}
        {item.username ? <button type="button" className="ghost sm" onClick={() => onCopy('username')} aria-label={`Copy username for ${item.name}`}>User</button> : null}
        {item.hasPassword && !item.passwordHidden ? <button type="button" className="ghost sm" onClick={() => onCopy('password')} aria-label={`Copy password for ${item.name}`}>Pass</button> : null}
        {item.hasTotp ? <button type="button" className="ghost sm" onClick={() => onCopy('totp')} aria-label={`Copy code for ${item.name}`}>Code</button> : null}
      </div>
    </li>
  )
}

function Brand({ name }: { name?: string | null }) {
  return <div className="brand"><img src="icons/icon-32.png" alt="" width="20" height="20" /><span>{name || 'Vault'}</span></div>
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
