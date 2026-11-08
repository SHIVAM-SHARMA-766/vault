// The breach check (D5, decisions/0019): each password is hashed with SHA-1
// here, and only the first five hex characters are sent — relayed by this
// server to Pwned Passwords, which answers with every known suffix under that
// prefix (padded). The comparison happens here. Results live in memory for
// this unlock only: which of your passwords are breached is itself sensitive.

import { breachCount } from '@vault/core'

import { api } from './api.js'
import * as session from './session.js'

const known = new Map<string, number>()   // full SHA-1 hex → breach count

async function sha1Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()
}

/** Breach counts by password, for every distinct password given. Prefixes
 *  are fetched a few at a time; `onProgress` reports done/total. */
export async function checkBreaches(passwords: readonly string[], onProgress?: (done: number, total: number) => void): Promise<Map<string, number>> {
  const distinct = [...new Set(passwords.filter(Boolean))]
  const hashes = new Map<string, string>()
  for (const p of distinct) hashes.set(p, await sha1Hex(p))
  const prefixes = [...new Set([...hashes.values()].filter((h) => !known.has(h)).map((h) => h.slice(0, 5)))]
  let done = 0
  const queue = [...prefixes]
  const worker = async () => {
    for (let prefix = queue.shift(); prefix; prefix = queue.shift()) {
      const { range } = await api.breachRange(await session.token(), prefix)
      for (const h of hashes.values()) if (h.startsWith(prefix)) known.set(h, breachCount(range, h.slice(5)))
      onProgress?.(++done, prefixes.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, prefixes.length) }, worker))
  const out = new Map<string, number>()
  for (const [p, h] of hashes) out.set(p, known.get(h) ?? 0)
  return out
}

/** Forget every result (on lock). */
export function forgetBreaches(): void { known.clear() }

// Locking forgets everything learned while unlocked.
session.subscribe((s) => { if (!s) forgetBreaches() })
