// Settings → Preferences: theme, auto-lock, clipboard clearing and the
// generator's defaults. Each change applies at once and is saved sealed under
// the vault key (lib/prefs.ts), so it follows the account to every device.

import { useState } from 'react'

import {
  CLIPBOARD_CHOICES, GENERATOR_MAX, GENERATOR_MIN, LOCK_CHOICES, type Prefs, type Theme,
  describeMinutes, describeSeconds,
} from '@vault/core'

import * as prefs from '../../lib/prefs.js'
import * as session from '../../lib/session.js'
import { IconClock, IconCopy, IconKey, IconSun } from '../../ui/icons.js'
import { Check, useToast } from '../../ui/kit.js'

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
      toast('Preferences saved')
    } catch {
      toast('Applied for now, but not saved — the server could not be reached', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <section className="settings-card" aria-labelledby="p-theme">
        <div className="settings-card-head"><IconSun size={18} /><h2 id="p-theme">Appearance</h2></div>
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
        <div className="settings-card-head"><IconClock size={18} /><h2 id="p-lock">Auto-lock</h2></div>
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
        <div className="settings-card-head"><IconCopy size={18} /><h2 id="p-clip">Clipboard</h2></div>
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

      <GeneratorDefaults p={p} saving={saving} change={change} />
    </>
  )
}

function GeneratorDefaults({ p, saving, change }: { p: Prefs; saving: boolean; change: (n: Partial<Prefs>) => Promise<void> }) {
  const g = p.generator
  const [length, setLength] = useState(g.length)
  const set = (next: Partial<Prefs['generator']>) => void change({ generator: { ...g, ...next } })
  return (
    <section className="settings-card" aria-labelledby="p-gen">
      <div className="settings-card-head"><IconKey size={18} /><h2 id="p-gen">Password generator</h2></div>
      <p className="muted small">What a new generated password looks like. You can still change it each time.</p>
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
    </section>
  )
}
