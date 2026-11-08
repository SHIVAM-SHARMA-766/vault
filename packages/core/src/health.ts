// Password health: weak, reused, old, and sent to an unencrypted site.
//
// Computed on the client from the decrypted vault; the server cannot do it
// and never learns the result. Nothing here sends a password anywhere — a
// breach check against a public corpus is a separate, undecided feature.

/** Passwords so common that their length is irrelevant. Lower-cased; the
 *  check also strips trailing digits and symbols ("Password123!" is here). */
const COMMON = new Set([
  'password', 'passw0rd', 'qwerty', 'qwertyuiop', 'asdfgh', 'asdfghjkl', 'zxcvbnm', 'letmein', 'welcome',
  'admin', 'administrator', 'login', 'iloveyou', 'monkey', 'dragon', 'master', 'sunshine', 'princess',
  'football', 'baseball', 'cricket', 'shadow', 'superman', 'batman', 'trustno1', 'abc', 'abcd', 'abcdef',
  'secret', 'changeme', 'default', 'guest', 'root', 'test', 'india', 'pakistan', 'hello', 'freedom',
  'whatever', 'computer', 'internet', 'samsung', 'google', 'facebook', 'pokemon', 'starwars', 'killer',
  'michael', 'jordan', 'charlie', 'ashley', 'jessica', 'qazwsx', 'mustang', 'access', 'flower', 'lovely',
])

const SEQUENCES = ['abcdefghijklmnopqrstuvwxyz', '01234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm']

/** Characters that sit in an ascending or descending run of 3+ from a known
 *  sequence ("abc", "321", "qwe") count once, not per character. */
function runPenalty(pw: string): number {
  const s = pw.toLowerCase()
  let penalised = 0
  for (let i = 0; i + 2 < s.length; i++) {
    const tri = s.slice(i, i + 3)
    const rev = [...tri].reverse().join('')
    if (SEQUENCES.some((q) => q.includes(tri) || q.includes(rev))) penalised++
  }
  return penalised
}

export type Strength = { score: 0 | 1 | 2 | 3 | 4; label: '' | 'Weak' | 'Fair' | 'Strong' | 'Excellent' }

/** A rough estimate: character pool and length, discounted for repeats,
 *  keyboard and alphabet runs, and the commonest passwords. It does not know
 *  dictionary words in general, so it errs generous; a nudge, not a proof. */
/** The word for each score, as the strength meter shows it; 0 is "any". */
export const STRENGTH_LABELS: readonly string[] = Object.freeze(['Any', 'Weak', 'Fair', 'Strong', 'Excellent'])

/** Why a master password falls short of a minimum score, or null if it
 *  meets it. Used where a server or organization policy sets a floor. */
export function belowMinimum(password: string, minScore: number): string | null {
  if (!minScore || passwordStrength(password).score >= minScore) return null
  return `This server asks for a master password rated at least ${STRENGTH_LABELS[minScore]}. Make it longer, or use a passphrase.`
}

export function passwordStrength(password: string): Strength {
  if (!password) return { score: 0, label: '' }
  const core = password.toLowerCase().replace(/[\d\W_]+$/, '').replace(/^[\d\W_]+/, '')
  // A single short word plus a number or a symbol — "summer2024", "Pune@123" —
  // is the first thing any guessing tool tries.
  const wordAndNumber = /^[a-z]{2,10}[\W_]?\d{1,4}[\W_]?$/i.test(password)
  if (COMMON.has(password.toLowerCase()) || COMMON.has(core) || wordAndNumber || /^(.)\1*$/.test(password) || /^\d{1,8}$/.test(password)) {
    return { score: 1, label: 'Weak' }
  }
  let pool = 0
  if (/[a-z]/.test(password)) pool += 26
  if (/[A-Z]/.test(password)) pool += 26
  if (/[0-9]/.test(password)) pool += 10
  if (/[^a-zA-Z0-9]/.test(password)) pool += 33
  const unique = new Set(password).size
  const effective = Math.max(1, Math.min(password.length, unique * 2) - runPenalty(password))
  const bits = Math.log2(Math.max(pool, 2)) * effective
  if (bits < 40) return { score: 1, label: 'Weak' }
  if (bits < 60) return { score: 2, label: 'Fair' }
  if (bits < 80) return { score: 3, label: 'Strong' }
  return { score: 4, label: 'Excellent' }
}

export type Issue = 'breached' | 'weak' | 'reused' | 'old' | 'insecure' | 'expired' | 'expiring'

/** Issues about a password, which the score counts. Expiry is about the
 *  item, shown beside them but not scored. */
export const PASSWORD_ISSUES: readonly Issue[] = ['breached', 'weak', 'reused', 'old', 'insecure']

/** How far ahead "expiring soon" looks. */
export const EXPIRING_DAYS = 30

export const ISSUES: readonly { issue: Issue; label: string; advice: string }[] = [
  { issue: 'breached', label: 'Breached', advice: 'This password appears in known data breaches, so attackers try it first. Change it here and everywhere else it is used.' },
  { issue: 'weak', label: 'Weak', advice: 'Easy to guess. Replace it with a generated password.' },
  { issue: 'reused', label: 'Reused', advice: 'The same password is used elsewhere in this vault. One leak opens every site that shares it.' },
  { issue: 'old', label: 'Old', advice: 'Not changed in over a year.' },
  { issue: 'insecure', label: 'Unencrypted site', advice: 'The saved website uses http://, so the password crosses the network in the clear.' },
  { issue: 'expired', label: 'Expired', advice: 'Its expiry date has passed. Renew it, or update the date.' },
  { issue: 'expiring', label: 'Expiring soon', advice: `It expires within ${EXPIRING_DAYS} days.` },
]

export interface HealthInput {
  id: string
  type: string
  password?: string | undefined
  url?: string | undefined
  /** When the password last changed, if known; otherwise updatedAt is used. */
  passwordChangedAt?: string | undefined
  updatedAt: string
  /** Type-specific fields, read for expiry dates. */
  fields?: Record<string, string> | undefined
}

export interface HealthReport {
  /** Entries with a password, i.e. the ones checked. */
  checked: number
  issues: Map<string, Issue[]>
  counts: Record<Issue, number>
  /** Entries with a password issue (expiry not counted). */
  failing: number
  /** 0–100: the share of checked entries with no password issue. 100 for an empty vault. */
  score: number
}

const OLD_DAYS = 365
const PASSWORD_TYPES = new Set(['login', 'wifi', 'database', 'server'])

/** When an item stops being valid, as epoch ms at the end of its last day,
 *  from a YYYY-MM-DD `expires` field or a card's MM/YY expiry. */
export function expiryOf(e: Pick<HealthInput, 'type' | 'fields'>): number | null {
  const date = e.fields?.['expires']
  const iso = date ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null
  if (iso) return Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]) + 1) - 1
  const card = e.type === 'card' ? /^(\d{2})\/(\d{2})$/.exec(e.fields?.['expiry'] ?? '') : null
  if (card && Number(card[1]) >= 1 && Number(card[1]) <= 12) return Date.UTC(2000 + Number(card[2]), Number(card[1]), 1) - 1
  return null
}

/** `breached` holds the ids of entries whose password a breach check found. */
export function analyse(entries: readonly HealthInput[], now = Date.now(), breached: ReadonlySet<string> = new Set()): HealthReport {
  // Types whose password a person chose and could reuse: not a card PIN or a
  // wallet password, which are checked by nobody else.
  const withPassword = entries.filter((e) => PASSWORD_TYPES.has(e.type) && e.password)
  const uses = new Map<string, number>()
  for (const e of withPassword) uses.set(e.password!, (uses.get(e.password!) ?? 0) + 1)

  const issues = new Map<string, Issue[]>()
  const counts: Record<Issue, number> = { breached: 0, weak: 0, reused: 0, old: 0, insecure: 0, expired: 0, expiring: 0 }
  let failing = 0
  for (const e of withPassword) {
    const found: Issue[] = []
    if (breached.has(e.id)) found.push('breached')
    if (passwordStrength(e.password!).score <= 1) found.push('weak')
    if ((uses.get(e.password!) ?? 0) > 1) found.push('reused')
    const changed = Date.parse(e.passwordChangedAt ?? e.updatedAt)
    if (Number.isFinite(changed) && now - changed > OLD_DAYS * 86_400_000) found.push('old')
    if (e.type === 'login' && /^http:\/\//i.test(e.url ?? '') && !/^http:\/\/(localhost|127\.|10\.|192\.168\.)/i.test(e.url ?? '')) found.push('insecure')
    if (found.length) {
      issues.set(e.id, found)
      for (const i of found) counts[i]++
      failing++
    }
  }
  for (const e of entries) {
    const end = expiryOf(e)
    if (end === null) continue
    const issue: Issue | null = end < now ? 'expired' : end - now < EXPIRING_DAYS * 86_400_000 ? 'expiring' : null
    if (!issue) continue
    issues.set(e.id, [...(issues.get(e.id) ?? []), issue])
    counts[issue]++
  }
  const score = withPassword.length ? Math.round(100 * (withPassword.length - failing) / withPassword.length) : 100
  return { checked: withPassword.length, failing, issues, counts, score }
}

/** How many breaches a Pwned Passwords range response says a password's
 *  SHA-1 suffix (the 35 hex characters after the 5 sent) appeared in. Padding
 *  lines (count 0) and other suffixes count as zero. */
export function breachCount(rangeBody: string, suffix: string): number {
  const want = suffix.toUpperCase()
  for (const line of rangeBody.split(/\r?\n/)) {
    const [s, n] = line.trim().split(':')
    if (s && s.toUpperCase() === want) return Number(n) || 0
  }
  return 0
}
