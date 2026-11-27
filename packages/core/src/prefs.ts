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

export const SEPARATORS = ['-', ' ', '.', '_'] as const

/** How the item list is ordered, and how much room each row takes. */
export type ListSort = 'name' | 'updated' | 'type'
export const LIST_SORTS: readonly ListSort[] = ['name', 'updated', 'type']
export type Density = 'comfortable' | 'compact'
export const DENSITIES: readonly Density[] = ['comfortable', 'compact']

/** Masked secrets: a fixed row of dots, which hides the length, or one dot
 *  per character. */
export type MaskLength = 'fixed' | 'actual'
export const MASK_LENGTHS: readonly MaskLength[] = ['fixed', 'actual']
/** Seconds a revealed secret stays visible; 0 keeps it until hidden. */
export const AUTO_HIDE_CHOICES = [0, 10, 30, 60] as const
export type DateStyle = 'system' | 'dmy' | 'mdy' | 'ymd'
export const DATE_STYLES: readonly DateStyle[] = ['system', 'dmy', 'mdy', 'ymd']
export type Clock = 'system' | '12h' | '24h'
export const CLOCKS: readonly Clock[] = ['system', '12h', '24h']
/** The app's language (E9); 'system' follows the browser. */
export type Language = 'system' | 'en' | 'hi' | 'es'
export const LANGUAGES: readonly Language[] = ['system', 'en', 'hi', 'es']

export interface GeneratorPrefs {
  mode: 'password' | 'passphrase'
  length: number
  upper: boolean
  digits: boolean
  symbols: boolean
  /** Passphrase: words, separator, capitals, a digit. */
  words: number
  separator: string
  capitalize: boolean
  digit: boolean
}

export interface Prefs {
  theme: Theme
  lockMinutes: number
  /** Lock as soon as the tab is hidden: another tab, minimised, screen off. */
  lockOnHide: boolean
  clipboardSeconds: number
  generator: GeneratorPrefs
  listSort: ListSort
  density: Density
  maskLength: MaskLength
  autoHideSeconds: number
  /** Where a new item goes when no folder is open; '' for none. */
  defaultFolderId: string
  dateStyle: DateStyle
  clock: Clock
  language: Language
  /** Show each item's website icon, fetched by this Vault server by host name
   *  (no sign-in sent); off shows a coloured initial instead. */
  siteIcons: boolean
}

export const DEFAULT_PREFS: Prefs = Object.freeze({
  theme: 'system',
  lockMinutes: 15,
  lockOnHide: false,
  clipboardSeconds: 30,
  listSort: 'name',
  density: 'comfortable',
  maskLength: 'fixed',
  autoHideSeconds: 30,
  defaultFolderId: '',
  dateStyle: 'system',
  clock: 'system',
  language: 'system',
  siteIcons: true,
  generator: Object.freeze({ mode: 'password', length: 20, upper: true, digits: true, symbols: true, words: 6, separator: '-', capitalize: false, digit: false }),
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
    listSort: pick(r['listSort'], LIST_SORTS, d.listSort),
    density: pick(r['density'], DENSITIES, d.density),
    maskLength: pick(r['maskLength'], MASK_LENGTHS, d.maskLength),
    autoHideSeconds: pick(r['autoHideSeconds'], AUTO_HIDE_CHOICES as readonly number[], d.autoHideSeconds),
    defaultFolderId: typeof r['defaultFolderId'] === 'string' && /^[A-Za-z0-9-]{0,64}$/.test(r['defaultFolderId']) ? r['defaultFolderId'] : d.defaultFolderId,
    dateStyle: pick(r['dateStyle'], DATE_STYLES, d.dateStyle),
    clock: pick(r['clock'], CLOCKS, d.clock),
    language: pick(r['language'], LANGUAGES, d.language),
    siteIcons: bool(r['siteIcons'], d.siteIcons),
    generator: {
      mode: pick(g['mode'], ['password', 'passphrase'] as const, d.generator.mode),
      length,
      upper: bool(g['upper'], d.generator.upper),
      digits: bool(g['digits'], d.generator.digits),
      symbols: bool(g['symbols'], d.generator.symbols),
      words: typeof g['words'] === 'number' && Number.isInteger(g['words']) ? Math.min(12, Math.max(3, g['words'])) : d.generator.words,
      separator: pick(g['separator'], SEPARATORS as readonly string[], d.generator.separator),
      capitalize: bool(g['capitalize'], d.generator.capitalize),
      digit: bool(g['digit'], d.generator.digit),
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

/** A date (and optionally its time) as the person asked to see them. `iso`
 *  is an ISO 8601 instant, or YYYY-MM-DD for a calendar date (shown as is,
 *  never shifted by time zone). */
export function formatWhen(iso: string, prefs: Pick<Prefs, 'dateStyle' | 'clock'>, opts: { time?: boolean; locale?: string; timeZone?: string } = {}): string {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso)
  const d = new Date(dateOnly ? `${iso}T00:00:00Z` : iso)
  if (Number.isNaN(d.getTime())) return iso
  const tz = dateOnly ? 'UTC' : opts.timeZone
  const parts = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(opts.locale, { ...o, ...(tz ? { timeZone: tz } : {}) })
    .formatToParts(d).reduce<Record<string, string>>((m, p) => { m[p.type] = p.value; return m }, {})
  let date: string
  if (prefs.dateStyle === 'system') {
    date = new Intl.DateTimeFormat(opts.locale, { year: 'numeric', month: 'short', day: 'numeric', ...(tz ? { timeZone: tz } : {}) }).format(d)
  } else {
    const p = parts({ year: 'numeric', month: '2-digit', day: '2-digit' })
    date = prefs.dateStyle === 'dmy' ? `${p['day']}/${p['month']}/${p['year']}` : prefs.dateStyle === 'mdy' ? `${p['month']}/${p['day']}/${p['year']}` : `${p['year']}-${p['month']}-${p['day']}`
  }
  if (!opts.time || dateOnly) return date
  const time = new Intl.DateTimeFormat(opts.locale, {
    hour: 'numeric', minute: '2-digit', ...(prefs.clock === 'system' ? {} : { hour12: prefs.clock === '12h' }), ...(tz ? { timeZone: tz } : {}),
  }).format(d)
  return `${date}, ${time}`
}
