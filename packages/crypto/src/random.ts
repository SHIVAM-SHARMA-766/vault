// The only source of randomness in this package.

/** Cryptographically secure random bytes. Present in browsers and in Node 20+
 *  under the same global name, so no platform branch is needed. */
export function randomBytes(length: number): Uint8Array {
  if (!Number.isInteger(length) || length <= 0) {
    throw new Error('randomBytes length must be a positive integer')
  }
  const out = new Uint8Array(length)
  globalThis.crypto.getRandomValues(out)
  return out
}
