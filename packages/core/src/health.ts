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

export type Issue = 'weak' | 'reused' | 'old' | 'insecure'

export const ISSUES: readonly { issue: Issue; label: string; advice: string }[] = [
  { issue: 'weak', label: 'Weak', advice: 'Easy to guess. Replace it with a generated password.' },
  { issue: 'reused', label: 'Reused', advice: 'The same password is used elsewhere in this vault. One leak opens every site that shares it.' },
  { issue: 'old', label: 'Old', advice: 'Not changed in over a year.' },
  { issue: 'insecure', label: 'Unencrypted site', advice: 'The saved website uses http://, so the password crosses the network in the clear.' },
]

export interface HealthInput {
  id: string
  type: string
  password?: string | undefined
  url?: string | undefined
  /** When the password last changed, if known; otherwise updatedAt is used. */
  passwordChangedAt?: string | undefined
  updatedAt: string
}

export interface HealthReport {
  /** Entries with a password, i.e. the ones checked. */
  checked: number
  issues: Map<string, Issue[]>
  counts: Record<Issue, number>
  /** 0–100: the share of checked entries with no issue. 100 for an empty vault. */
  score: number
}

const OLD_DAYS = 365
const PASSWORD_TYPES = new Set(['login', 'wifi', 'database', 'server'])

export function analyse(entries: readonly HealthInput[], now = Date.now()): HealthReport {
  // Types whose password a person chose and could reuse: not a card PIN or a
  // wallet password, which are checked by nobody else.
  const withPassword = entries.filter((e) => PASSWORD_TYPES.has(e.type) && e.password)
  const uses = new Map<string, number>()
  for (const e of withPassword) uses.set(e.password!, (uses.get(e.password!) ?? 0) + 1)

  const issues = new Map<string, Issue[]>()
  const counts: Record<Issue, number> = { weak: 0, reused: 0, old: 0, insecure: 0 }
  for (const e of withPassword) {
    const found: Issue[] = []
    if (passwordStrength(e.password!).score <= 1) found.push('weak')
    if ((uses.get(e.password!) ?? 0) > 1) found.push('reused')
    const changed = Date.parse(e.passwordChangedAt ?? e.updatedAt)
    if (Number.isFinite(changed) && now - changed > OLD_DAYS * 86_400_000) found.push('old')
    if (e.type === 'login' && /^http:\/\//i.test(e.url ?? '') && !/^http:\/\/(localhost|127\.|10\.|192\.168\.)/i.test(e.url ?? '')) found.push('insecure')
    if (found.length) {
      issues.set(e.id, found)
      for (const i of found) counts[i]++
    }
  }
  const score = withPassword.length ? Math.round(100 * (withPassword.length - issues.size) / withPassword.length) : 100
  return { checked: withPassword.length, issues, counts, score }
}
