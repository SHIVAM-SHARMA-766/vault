// Random passwords, for the web app's generator and the browser extension's
// "generate" in a sign-up form (decisions/0029). Both follow the account's
// generator preferences (prefs.ts).

import { generatePassphrase } from './passphrase.js'
import type { GeneratorPrefs } from './prefs.js'

const SETS = {
  lower: 'abcdefghijkmnopqrstuvwxyz',
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  digits: '23456789',
  symbols: '!@#$%^&*()-_=+[]{};:,.?',
}

/** Uniform over the alphabet: bytes above the largest multiple of its length
 *  are rejected rather than folded, which would bias the low characters. */
export function generatePassword(length: number, opts: { upper: boolean; digits: boolean; symbols: boolean }): string {
  const alphabet = SETS.lower + (opts.upper ? SETS.upper : '') + (opts.digits ? SETS.digits : '') + (opts.symbols ? SETS.symbols : '')
  const limit = 256 - (256 % alphabet.length)
  let out = ''
  while (out.length < length) {
    for (const b of globalThis.crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (b < limit && out.length < length) out += alphabet[b % alphabet.length]
    }
  }
  return out
}

/** A password or passphrase as the preferences describe it. `words` is the
 *  EFF list (`@vault/core/words`), needed only for a passphrase. */
export function generateFromPrefs(g: GeneratorPrefs, words?: readonly string[]): string {
  if (g.mode === 'passphrase' && words) return generatePassphrase(words, g)
  return generatePassword(g.length, g)
}
