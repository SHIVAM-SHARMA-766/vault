// Settings → Preferences: theme, auto-lock, clipboard clearing and the
// generator's defaults. Each change applies at once and is saved sealed under
// the vault key (lib/prefs.ts), so it follows the account to every device.

import { useEffect, useState } from 'react'

import { openFolder } from '@vault/crypto'
import {
  AUTO_HIDE_CHOICES, CLIPBOARD_CHOICES, type Language, type Clock, type DateStyle, GENERATOR_MAX, GENERATOR_MIN, LOCK_CHOICES, SEPARATORS, type Prefs, type Theme,
  describeMinutes, describeSeconds, flattenTree, folderTree, formatWhen, passphraseBits,
} from '@vault/core'

import { api } from '../../lib/api.js'
import { useInstance } from '../../lib/instance.js'
import type { Folder } from '../vault/model.js'

import * as prefs from '../../lib/prefs.js'
import * as session from '../../lib/session.js'
import { IconClock, IconCopy, IconEye, IconGlobe, IconFolder, IconInbox, IconKey, IconSun } from '../../ui/icons.js'
import { Check, useToast } from '../../ui/kit.js'
import { LOCALE_NAMES, t } from '../../lib/i18n.js'

const THEME_LABELS: Record<Theme, string> = { system: 'Match system', light: 'Light', dark: 'Dark' }

export function Preferences({ state }: { state: session.Unlocked }) {
  const p = prefs.usePrefs()
  const toast = useToast()
  const [saving, setSaving] = useState(false)
  const policyShorter = session.idleMinutes() < p.lockMinutes

  async function change(next: Partial<Prefs>) {
    setSaving(true)
    try {
      await prefs.save(state.vaultKey, next)
      toast(t('Preferences saved'))
    } catch {
      toast('Applied for now, but not saved — the server could not be reached', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <section className="settings-card" aria-labelledby="p-theme">
        <div className="settings-card-head"><IconSun size={18} /><h2 id="p-theme">{t('Appearance')}</h2></div>
        <p className="muted small">Light, dark, or whatever your device is set to.</p>
        <div className="segmented" role="radiogroup" aria-labelledby="p-theme">
          {(Object.keys(THEME_LABELS) as Theme[]).map((t) => (
            <button key={t} type="button" role="radio" aria-checked={p.theme === t} disabled={saving}
                    className={p.theme === t ? 'seg-active' : ''} onClick={() => void change({ theme: t })}>
              {THEME_LABELS[t]}
            </button>
          ))}
        </div>
      </section>

      <section className="settings-card" aria-labelledby="p-lock">
        <div className="settings-card-head"><IconClock size={18} /><h2 id="p-lock">{t('Auto-lock')}</h2></div>
        <p className="muted small">
          After this long without a click or key press, the vault locks and forgets its keys. Closing or reloading
          the tab always locks it.
        </p>
        <div className="field">
          <label htmlFor="p-lock-minutes">Lock after</label>
          <select id="p-lock-minutes" value={p.lockMinutes} disabled={saving}
                  onChange={(e) => void change({ lockMinutes: Number(e.target.value) })}>
            {LOCK_CHOICES.map((m) => <option key={m} value={m}>{describeMinutes(m)} idle</option>)}
          </select>
          {policyShorter ? (
            <p className="hint">Your organization locks sooner: after {describeMinutes(session.idleMinutes())}.</p>
          ) : null}
        </div>
        <Check checked={p.lockOnHide} onChange={(v) => void change({ lockOnHide: v })}>
          Also lock as soon as I switch to another tab or window
        </Check>
      </section>

      <section className="settings-card" aria-labelledby="p-clip">
        <div className="settings-card-head"><IconCopy size={18} /><h2 id="p-clip">{t('Clipboard')}</h2></div>
        <p className="muted small">
          A copied password is cleared from the clipboard after this long, if it is still there and this tab is
          in front.
        </p>
        <div className="field">
          <label htmlFor="p-clip-seconds">Clear copied secrets after</label>
          <select id="p-clip-seconds" value={p.clipboardSeconds} disabled={saving}
                  onChange={(e) => void change({ clipboardSeconds: Number(e.target.value) })}>
            {CLIPBOARD_CHOICES.map((s) => <option key={s} value={s}>{s === 0 ? 'Never clear' : describeSeconds(s)}</option>)}
          </select>
        </div>
      </section>

      <section className="settings-card" aria-labelledby="p-language">
        <div className="settings-card-head"><IconGlobe size={18} /><h2 id="p-language">{t('Language')}</h2></div>
        <div className="field">
          <label htmlFor="p-lang">{t('Language')}</label>
          <select id="p-lang" value={p.language} disabled={saving} onChange={(e) => void change({ language: e.target.value as Language })}>
            <option value="system">{t('As my browser does')}</option>
            {(['en', 'hi', 'es'] as const).map((l) => <option key={l} value={l}>{LOCALE_NAMES[l]}</option>)}
          </select>
          <p className="hint">Hindi and Spanish cover the main screens so far; anything not yet translated shows in English.</p>
        </div>
      </section>

      <section className="settings-card" aria-labelledby="p-secrets">
        <div className="settings-card-head"><IconEye size={18} /><h2 id="p-secrets">Secrets on screen</h2></div>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="p-mask">Masked passwords show</label>
            <select id="p-mask" value={p.maskLength} disabled={saving} onChange={(e) => void change({ maskLength: e.target.value as Prefs['maskLength'] })}>
              <option value="fixed">The same dots for every password</option>
              <option value="actual">One dot per character</option>
            </select>
            <p className="hint">The same dots hide how long a password is from anyone looking at your screen.</p>
          </div>
          <div className="field">
            <label htmlFor="p-autohide">Hide a revealed secret again after</label>
            <select id="p-autohide" value={p.autoHideSeconds} disabled={saving} onChange={(e) => void change({ autoHideSeconds: Number(e.target.value) })}>
              {AUTO_HIDE_CHOICES.map((s) => <option key={s} value={s}>{s === 0 ? 'Keep it shown' : describeSeconds(s)}</option>)}
            </select>
          </div>
        </div>
      </section>

      <DefaultFolder state={state} p={p} saving={saving} change={change} />

      <section className="settings-card" aria-labelledby="p-dates">
        <div className="settings-card-head"><IconClock size={18} /><h2 id="p-dates">{t('Dates and times')}</h2></div>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="p-date">Dates</label>
            <select id="p-date" value={p.dateStyle} disabled={saving} onChange={(e) => void change({ dateStyle: e.target.value as DateStyle })}>
              <option value="system">As my browser does</option>
              <option value="dmy">Day/month/year (31/12/2026)</option>
              <option value="mdy">Month/day/year (12/31/2026)</option>
              <option value="ymd">Year-month-day (2026-12-31)</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="p-clock">Times</label>
            <select id="p-clock" value={p.clock} disabled={saving} onChange={(e) => void change({ clock: e.target.value as Clock })}>
              <option value="system">As my browser does</option>
              <option value="24h">24-hour (17:05)</option>
              <option value="12h">12-hour (5:05 pm)</option>
            </select>
          </div>
        </div>
        <p className="hint" data-testid="date-preview">Now: {formatWhen(new Date().toISOString(), p, { time: true })}</p>
      </section>

      <EmailAlerts />

      <GeneratorDefaults p={p} saving={saving} change={change} />
    </>
  )
}

/** Where a new item goes when no folder is open (F6). */
function DefaultFolder({ state, p, saving, change }: { state: session.Unlocked; p: Prefs; saving: boolean; change: (n: Partial<Prefs>) => Promise<void> }) {
  const [folders, setFolders] = useState<Folder[] | null>(null)
  useEffect(() => {
    void (async () => {
      try {
        const { folders: sealed } = await api.vault(await session.token())
        const opened = await Promise.all(sealed.map(async (f) => { try { return { ...(await openFolder(f.id, f.blob, state.vaultKey)), id: f.id } } catch { return null } }))
        setFolders(opened.filter((f): f is Folder => f !== null))
      } catch { setFolders([]) }
    })()
  }, [state.vaultKey])
  const options = folders ? flattenTree(folderTree(folders)) : []
  const missing = p.defaultFolderId && folders && !folders.some((f) => f.id === p.defaultFolderId)
  return (
    <section className="settings-card" aria-labelledby="p-folder">
      <div className="settings-card-head"><IconFolder size={18} /><h2 id="p-folder">New items</h2></div>
      <div className="field">
        <label htmlFor="p-default-folder">Put new items in</label>
        <select id="p-default-folder" value={missing ? '' : p.defaultFolderId} disabled={saving || folders === null} onChange={(e) => void change({ defaultFolderId: e.target.value })}>
          <option value="">No folder</option>
          {options.map((n) => <option key={n.folder.id} value={n.folder.id}>{'\u00a0\u00a0'.repeat(n.depth)}{n.folder.name}</option>)}
        </select>
        <p className="hint">Used when no folder is open. Opening a folder first still puts the item there.</p>
      </div>
    </section>
  )
}

/** The one email alert a zero-knowledge server can send (F5). */
function EmailAlerts() {
  const toast = useToast()
  const mail = useInstance()?.mail
  const [on, setOn] = useState<boolean | null>(null)
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    void (async () => {
      try { const a = await api.alerts(await session.token()); setOn(a.signIn); setAvailable(a.available) } catch { setOn(null) }
    })()
  }, [])
  if (!mail || on === null) return null
  return (
    <section className="settings-card" aria-labelledby="p-alerts">
      <div className="settings-card-head"><IconInbox size={18} /><h2 id="p-alerts">Email alerts</h2></div>
      {available ? (
        <Check checked={on} onChange={async (v) => {
          try { await api.setAlerts(await session.token(), v); setOn(v); toast(v ? 'Sign-in emails on' : 'Sign-in emails off') }
          catch (err) { toast(err instanceof Error ? err.message : 'Could not save.', 'error') }
        }}>Email me when my account signs in on a device</Check>
      ) : <p className="muted small">This server does not send sign-in emails.</p>}
      <p className="hint">This server keeps only a fingerprint of your address, so it can write to you only as you sign in. Signing in with your recovery key is always announced.</p>
    </section>
  )
}

function GeneratorDefaults({ p, saving, change }: { p: Prefs; saving: boolean; change: (n: Partial<Prefs>) => Promise<void> }) {
  const g = p.generator
  const [length, setLength] = useState(g.length)
  const set = (next: Partial<Prefs['generator']>) => void change({ generator: { ...g, ...next } })
  return (
    <section className="settings-card" aria-labelledby="p-gen">
      <div className="settings-card-head"><IconKey size={18} /><h2 id="p-gen">Password generator</h2></div>
      <p className="muted small">What the generator offers first. You can still change it each time.</p>
      <div className="segmented generator-mode" role="radiogroup" aria-label="Generate by default">
        {(['password', 'passphrase'] as const).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={g.mode === m} disabled={saving}
                  className={g.mode === m ? 'seg-active' : ''} onClick={() => set({ mode: m })}>
            {m === 'password' ? 'Password' : 'Passphrase'}
          </button>
        ))}
      </div>
      {g.mode === 'passphrase' ? (
        <div className="grid-2">
          <div className="field">
            <label htmlFor="p-words">Words</label>
            <select id="p-words" value={g.words} disabled={saving} onChange={(e) => set({ words: Number(e.target.value) })}>
              {[4, 5, 6, 7, 8, 10, 12].map((n) => <option key={n} value={n}>{n} words (about {Math.round(passphraseBits({ words: n, digit: false }))} bits)</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="p-sep">Between words</label>
            <select id="p-sep" value={g.separator} disabled={saving} onChange={(e) => set({ separator: e.target.value })}>
              {SEPARATORS.map((x) => <option key={x} value={x}>{x === ' ' ? 'a space' : x === '-' ? 'a hyphen (-)' : x === '.' ? 'a full stop (.)' : 'an underscore (_)'}</option>)}
            </select>
          </div>
          <Check checked={g.capitalize} onChange={(v) => set({ capitalize: v })}>Capitalise each word</Check>
          <Check checked={g.digit} onChange={(v) => set({ digit: v })}>Add a digit</Check>
        </div>
      ) : (
      <div className="generator-opts">
        <label className="range">
          <span>Length <strong>{length}</strong></span>
          <input type="range" min={GENERATOR_MIN} max={GENERATOR_MAX} value={length} disabled={saving} aria-label="Default length"
                 onChange={(e) => setLength(Number(e.target.value))}
                 onPointerUp={() => length !== g.length && set({ length })}
                 onKeyUp={() => length !== g.length && set({ length })} />
        </label>
        <Check checked={g.upper} onChange={(v) => set({ upper: v })}>A–Z</Check>
        <Check checked={g.digits} onChange={(v) => set({ digits: v })}>0–9</Check>
        <Check checked={g.symbols} onChange={(v) => set({ symbols: v })}>!@#</Check>
      </div>
      )}
    </section>
  )
}
