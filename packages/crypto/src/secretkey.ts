// The opt-in secret key (decisions/0027).
//
// A random 128-bit value that never leaves the person's devices, mixed into
// the master key. With it, the server's copy of an account (the auth verifier
// and the wrapped vault key) cannot be attacked by guessing passwords: each
// guess would also need the 128 secret bits.
//
//   PBKDF2(password, salt, iterations) ──┐
//                                        XOR ── HKDF "vault.master.v2" ──> Master Key
//   HKDF(secretKey, "vault.secret-key.v1") ┘
//
// Written down as `SK1-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX`: Crockford
// base32 of the 16 key bytes followed by the first 4 bytes of their SHA-256,
// so a mistyped key is caught before it is ever used to derive anything.

import { fromRecoveryString, toRecoveryString, utf8Encode } from './encoding.js'
import { hkdfSha256 } from './primitives.js'
import { randomBytes } from './random.js'

export const SECRET_KEY_BYTES = 16
const CHECK_BYTES = 4
const PREFIX = 'SK1'

const INFO_SECRET = 'vault.secret-key.v1'
const INFO_MASTER_V2 = 'vault.master.v2'

export class SecretKeyFormatError extends Error {
  constructor(message = 'That is not a valid secret key.') {
    super(message)
    this.name = 'SecretKeyFormatError'
  }
}

export function generateSecretKey(): Uint8Array {
  return randomBytes(SECRET_KEY_BYTES)
}

async function check(key: Uint8Array): Promise<Uint8Array> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', key as Uint8Array<ArrayBuffer>))
  return digest.slice(0, CHECK_BYTES)
}

/** `SK1-` and eight groups of four Crockford characters. */
export async function formatSecretKey(key: Uint8Array): Promise<string> {
  if (key.length !== SECRET_KEY_BYTES) throw new SecretKeyFormatError()
  const bytes = new Uint8Array(SECRET_KEY_BYTES + CHECK_BYTES)
  bytes.set(key)
  bytes.set(await check(key), SECRET_KEY_BYTES)
  return `${PREFIX}-${toRecoveryString(bytes)}`
}

/** Accepts any case, any grouping, with or without the prefix, and the usual
 *  look-alike substitutions. Throws SecretKeyFormatError when the length or
 *  the checksum is wrong. */
export async function parseSecretKey(text: string): Promise<Uint8Array> {
  let body = text.toUpperCase().replace(/[\s-]/g, '')
  if (body.startsWith(PREFIX) && body.length === PREFIX.length + 32) body = body.slice(PREFIX.length)
  if (body.length !== 32) throw new SecretKeyFormatError()
  let bytes: Uint8Array
  try { bytes = fromRecoveryString(body) } catch { throw new SecretKeyFormatError() }
  if (bytes.length !== SECRET_KEY_BYTES + CHECK_BYTES) throw new SecretKeyFormatError()
  const key = bytes.slice(0, SECRET_KEY_BYTES)
  const expected = await check(key)
  let diff = 0
  for (let i = 0; i < CHECK_BYTES; i++) diff |= expected[i]! ^ bytes[SECRET_KEY_BYTES + i]!
  if (diff !== 0) throw new SecretKeyFormatError('That secret key has a typo: check each group again.')
  return key
}

/** Mix a secret key into the PBKDF2 output (the v2 master key). */
export async function mixSecretKey(stretched: Uint8Array, secretKey: Uint8Array): Promise<Uint8Array> {
  if (secretKey.length !== SECRET_KEY_BYTES) throw new SecretKeyFormatError()
  const expanded = await hkdfSha256(secretKey, new Uint8Array(0), utf8Encode(INFO_SECRET), stretched.length)
  const mixed = new Uint8Array(stretched.length)
  for (let i = 0; i < mixed.length; i++) mixed[i] = stretched[i]! ^ expanded[i]!
  expanded.fill(0)
  const master = await hkdfSha256(mixed, new Uint8Array(0), utf8Encode(INFO_MASTER_V2), stretched.length)
  mixed.fill(0)
  return master
}
