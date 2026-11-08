// Passphrases: words drawn uniformly from the EFF large list with the
// platform's CSPRNG, so each word adds log2(7776) ≈ 12.9 bits. Six words is
// about 77 bits — stronger than a random 12-character password, and far
// easier to type on a phone or read out.

export interface PassphraseOptions {
  words: number
  separator: string
  capitalize: boolean
  /** Append one digit to one word, for sites that insist on a number. */
  digit: boolean
}

export const PASSPHRASE_MIN_WORDS = 3
export const PASSPHRASE_MAX_WORDS = 12
export const BITS_PER_WORD = Math.log2(7776)

/** A uniform integer in [0, n), rejecting the biased tail. */
function uniform(n: number, random: (bytes: Uint8Array) => Uint8Array): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n
  const buf = new Uint8Array(4)
  for (;;) {
    random(buf)
    const v = ((buf[0]! << 24) | (buf[1]! << 16) | (buf[2]! << 8) | buf[3]!) >>> 0
    if (v < limit) return v % n
  }
}

export function generatePassphrase(
  list: readonly string[],
  opts: PassphraseOptions,
  random: (bytes: Uint8Array) => Uint8Array = (b) => globalThis.crypto.getRandomValues(b),
): string {
  const count = Math.min(PASSPHRASE_MAX_WORDS, Math.max(PASSPHRASE_MIN_WORDS, Math.floor(opts.words)))
  const words = Array.from({ length: count }, () => list[uniform(list.length, random)]!)
  const shaped = words.map((w) => (opts.capitalize ? w[0]!.toUpperCase() + w.slice(1) : w))
  if (opts.digit) {
    const i = uniform(shaped.length, random)
    shaped[i] = `${shaped[i]}${uniform(10, random)}`
  }
  return shaped.join(opts.separator)
}

/** Strength in bits, for the meter: words, plus a little for the digit. */
export function passphraseBits(opts: Pick<PassphraseOptions, 'words' | 'digit'>): number {
  return opts.words * BITS_PER_WORD + (opts.digit ? Math.log2(10 * opts.words) : 0)
}
