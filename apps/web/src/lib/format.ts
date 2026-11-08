// Dates and times as the person chose to see them (Settings → Preferences,
// F7). Every screen formats through here rather than calling toLocaleString.

import { formatWhen } from '@vault/core'

import * as prefs from './prefs.js'

/** Date and time, e.g. "8 Nov 2026, 14:05"; '—' for nothing or junk. */
export function when(iso: string | null | undefined): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return '—'
  return formatWhen(iso, prefs.get(), { time: true })
}

/** Date only. YYYY-MM-DD calendar dates are shown as typed, never shifted. */
export function day(iso: string | null | undefined): string {
  if (!iso) return '—'
  return formatWhen(iso, prefs.get())
}
