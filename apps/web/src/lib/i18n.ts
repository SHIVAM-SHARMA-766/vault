// Languages (E9). Strings are written in English in the code and looked up in
// a catalog by that same English text, so an untranslated string simply shows
// in English. Catalogs live in lib/locales/; adding a language is adding a file.
//
// The language is a preference (sealed and synced like the others). Before
// sign-in, the one last used on this device applies, so the sign-in page is
// already in the right language.

import { useEffect, useState } from 'react'

import type { Language } from '@vault/core'

import { es } from './locales/es.js'
import { hi } from './locales/hi.js'

export type Locale = 'en' | 'hi' | 'es'
const CATALOGS: Record<Exclude<Locale, 'en'>, Record<string, string>> = { hi, es }
export const LOCALE_NAMES: Record<Locale, string> = { en: 'English', hi: 'हिन्दी (Hindi)', es: 'Español (Spanish)' }
const KEY = 'vault.lang'

function fromBrowser(): Locale {
  for (const l of navigator.languages ?? [navigator.language]) {
    const base = l.toLowerCase().split('-')[0]
    if (base === 'hi' || base === 'es' || base === 'en') return base
  }
  return 'en'
}

function initial(): Locale {
  try {
    const stored = localStorage.getItem(KEY)
    if (stored === 'en' || stored === 'hi' || stored === 'es') return stored
  } catch { /* storage blocked */ }
  return fromBrowser()
}

let locale: Locale = initial()
const listeners = new Set<(l: Locale) => void>()
document.documentElement.lang = locale

export const currentLocale = (): Locale => locale

/** Applies a language preference ('system' follows the browser). */
export function setLanguage(pref: Language): void {
  const next: Locale = pref === 'system' ? fromBrowser() : pref
  try { if (pref === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, pref) } catch { /* fine */ }
  if (next === locale) return
  locale = next
  document.documentElement.lang = next
  for (const l of listeners) l(next)
}

/** The text in the current language. `{name}` placeholders are filled from
 *  `vars`. */
export function t(text: string, vars?: Record<string, string | number>): string {
  const translated = locale === 'en' ? text : CATALOGS[locale][text] ?? text
  return vars ? translated.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : translated
}

/** Re-renders on a language change; returns the current locale. */
export function useLocale(): Locale {
  const [l, setL] = useState(locale)
  useEffect(() => { listeners.add(setL); return () => { listeners.delete(setL) } }, [])
  return l
}
