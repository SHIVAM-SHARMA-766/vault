// The account's preferences on this device: read once per unlock, sealed
// under the vault key on the server (services/api routes/prefs.ts), applied
// to the session, the clipboard and the page theme.
//
// The theme alone is also kept in localStorage, so the sign-in screen opens in
// the right colours before anything is unlocked. It is the one preference
// that says nothing about the vault.

import { useEffect, useState } from 'react'

import { DEFAULT_PREFS, type Prefs, type Theme, normalizePrefs } from '@vault/core'
import { sealJson, unsealJson, utf8Encode } from '@vault/crypto'

import { api } from './api.js'
import * as session from './session.js'

const AAD = utf8Encode('vault.prefs.v1')
const THEME_KEY = 'vault.theme'

let current: Prefs = DEFAULT_PREFS
const listeners = new Set<(p: Prefs) => void>()

export const get = (): Prefs => current

export function usePrefs(): Prefs {
  const [p, setP] = useState(current)
  useEffect(() => { listeners.add(setP); return () => { listeners.delete(setP) } }, [])
  return p
}

/** Applies a theme to the page. 'system' follows the operating system. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  if (theme === 'system') delete root.dataset['theme']
  else root.dataset['theme'] = theme
  try {
    if (theme === 'system') localStorage.removeItem(THEME_KEY)
    else localStorage.setItem(THEME_KEY, theme)
  } catch { /* storage blocked: the theme still applies until reload */ }
}

/** Before first paint: the theme last chosen on this device. */
export function applyStoredTheme(): void {
  let stored: string | null = null
  try { stored = localStorage.getItem(THEME_KEY) } catch { /* storage blocked */ }
  if (stored === 'light' || stored === 'dark') {
    document.documentElement.dataset['theme'] = stored
    current = { ...current, theme: stored }
  }
}

function apply(p: Prefs): void {
  current = p
  applyTheme(p.theme)
  session.setUserIdle(p.lockMinutes)
  session.setLockOnHide(p.lockOnHide)
  for (const l of listeners) l(p)
}

/** Reads the sealed preferences after an unlock. A missing or unreadable blob
 *  means the defaults, never a failed unlock. */
export async function load(vaultKey: Uint8Array): Promise<void> {
  try {
    const { blob } = await api.prefs(await session.token())
    apply(blob ? normalizePrefs(await unsealJson(vaultKey, blob, AAD)) : { ...DEFAULT_PREFS, theme: current.theme })
  } catch {
    apply(current)
  }
}

/** Changes some preferences, applies them at once, and saves them sealed. */
export async function save(vaultKey: Uint8Array, change: Partial<Prefs>): Promise<void> {
  const next = normalizePrefs({ ...current, ...change })
  apply(next)
  await api.putPrefs(await session.token(), await sealJson(vaultKey, next, AAD))
}

/** On lock, the session-bound preferences return to their defaults; the theme
 *  stays, so the sign-in screen does not flash. */
export function reset(): void {
  apply({ ...DEFAULT_PREFS, theme: current.theme })
}
