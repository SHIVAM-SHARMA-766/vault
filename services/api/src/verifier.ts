// Server-side hashing of the client's Auth Key.
//
// The Auth Key is already the output of 600,000 PBKDF2 iterations over a
// salted password, so it is high-entropy and not guessable on its own. Hashing
// it again is defence in depth against disclosure of the table: an attacker
// with the stored verifier still cannot replay it as a login.
//
// scrypt from node:crypto rather than bcrypt. bcrypt is a native module that
// has to be compiled for the Lambda architecture; scrypt is in the runtime,
// which removes a build step and a class of deployment failure. It is also
// memory-hard, which bcrypt is not.

import { type ScryptOptions, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'

// Wrapped by hand rather than with promisify, which resolves to the overload
// without an options argument and so silently drops the cost parameters.
function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derived) => {
      if (err) reject(err)
      else resolve(derived)
    })
  })
}

const N = 1 << 15
const r = 8
const p = 1
const KEY_BYTES = 32
const SALT_BYTES = 16

// scrypt needs roughly 128 * N * r bytes — about 33 MB at these parameters,
// which is over Node's 32 MB default and would otherwise throw at runtime
// rather than in a test.
const MAX_MEM = 64 * 1024 * 1024

/** `scrypt$N$r$p$salt$hash`, all base64url. Self-describing so the parameters
 *  can be raised later without invalidating existing verifiers. */
export async function hashAuthKey(authKeyB64: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const hash = await scrypt(authKeyB64, salt, KEY_BYTES, { N, r, p, maxmem: MAX_MEM })
  return ['scrypt', N, r, p, salt.toString('base64url'), hash.toString('base64url')].join('$')
}

export async function verifyAuthKey(authKeyB64: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false

  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts as [string, string, string, string, string, string]
  const params = { N: Number(nRaw), r: Number(rRaw), p: Number(pRaw), maxmem: MAX_MEM }
  if (!Number.isInteger(params.N) || !Number.isInteger(params.r) || !Number.isInteger(params.p)) {
    return false
  }

  const expected = Buffer.from(hashRaw, 'base64url')
  const salt = Buffer.from(saltRaw, 'base64url')

  let actual: Buffer
  try {
    actual = await scrypt(authKeyB64, salt, expected.length, params)
  } catch {
    return false
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
