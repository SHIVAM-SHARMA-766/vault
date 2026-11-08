// An account's preferences, as every client reads them. They travel sealed
// (services/api routes/prefs.ts), so the server cannot check them; a client
// therefore never trusts the shape it decrypts and falls back, field by
// field, to the defaults below.

export type Theme = 'system' | 'light' | 'dark'
export const THEMES: readonly Theme[] = ['system', 'light', 'dark']

/** Minutes of inactivity before the vault locks. An organization policy can
 *  only shorten it. */
export const LOCK_CHOICES = [1, 5, 15, 30, 60, 240] as const
/** Seconds a copied secret stays on the clipboard; 0 leaves it there. */
export const CLIPBOARD_CHOICES = [0, 10, 30, 60, 120] as const

export const GENERATOR_MIN = 8
export const GENERATOR_MAX = 64

export interface GeneratorPrefs {
  length: number
  upper: boolean
  digits: boolean
  symbols: boolean
}

export interface Prefs {
  theme: Theme
  lockMinutes: number
  /** Lock as soon as the tab is hidden: another tab, minimised, screen off. */
  lockOnHide: boolean
  clipboardSeconds: number
  generator: GeneratorPrefs
}

export const DEFAULT_PREFS: Prefs = Object.freeze({
  theme: 'system',
  lockMinutes: 15,
  lockOnHide: false,
  clipboardSeconds: 30,
  generator: Object.freeze({ length: 20, upper: true, digits: true, symbols: true }),
}) as Prefs

const pick = <T>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback
const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback)

/** Whatever was decrypted, a complete and valid Prefs. */
export function normalizePrefs(raw: unknown): Prefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const g = (r['generator'] && typeof r['generator'] === 'object' ? r['generator'] : {}) as Record<string, unknown>
  const d = DEFAULT_PREFS
  const length = typeof g['length'] === 'number' && Number.isInteger(g['length'])
    ? Math.min(GENERATOR_MAX, Math.max(GENERATOR_MIN, g['length'])) : d.generator.length
  return {
    theme: pick(r['theme'], THEMES, d.theme),
    lockMinutes: pick(r['lockMinutes'], LOCK_CHOICES as readonly number[], d.lockMinutes),
    lockOnHide: bool(r['lockOnHide'], d.lockOnHide),
    clipboardSeconds: pick(r['clipboardSeconds'], CLIPBOARD_CHOICES as readonly number[], d.clipboardSeconds),
    generator: {
      length,
      upper: bool(g['upper'], d.generator.upper),
      digits: bool(g['digits'], d.generator.digits),
      symbols: bool(g['symbols'], d.generator.symbols),
    },
  }
}

/** The idle lock in force: the person's choice, shortened by the strictest
 *  organization policy they are under (null when none sets one). */
export function effectiveLockMinutes(prefs: Pick<Prefs, 'lockMinutes'>, policyMinutes: number | null): number {
  return policyMinutes && policyMinutes > 0 ? Math.min(prefs.lockMinutes, policyMinutes) : prefs.lockMinutes
}

/** Human wording for a lock or clipboard choice. */
export function describeMinutes(m: number): string {
  return m < 60 ? `${m} minute${m === 1 ? '' : 's'}` : `${m / 60} hour${m === 60 ? '' : 's'}`
}
export function describeSeconds(s: number): string {
  return s === 0 ? 'Never' : s < 60 ? `${s} seconds` : `${s / 60} minute${s === 60 ? '' : 's'}`
}
