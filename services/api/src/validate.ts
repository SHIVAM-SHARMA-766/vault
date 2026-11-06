import { PUBLIC_KEY_BYTES, isValidPublicKey } from '@vault/crypto'

import { badRequest, tooLarge } from './http.js'

/** Generous, because the address is only ever used to derive a digest — this
 *  rejects nonsense, it does not attempt to decide what a deliverable address
 *  looks like. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function requireEmail(value: unknown): string {
  if (typeof value !== 'string' || value.length > 254 || !EMAIL_PATTERN.test(value.trim())) {
    throw badRequest('A valid email address is required.')
  }
  return value.trim()
}

/** A base64url value of an exact decoded byte length. Used for the auth key and
 *  the KDF salt, both of which are always 32 bytes. */
export function requireBase64UrlBytes(value: unknown, bytes: number, field: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw badRequest(`${field} must be a base64url string.`)
  }
  if (Buffer.from(value, 'base64url').length !== bytes) {
    throw badRequest(`${field} must decode to ${bytes} bytes.`)
  }
  return value
}

const SEALED_PATTERN = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

/** The server cannot read a sealed blob, so this checks only that it has the
 *  shape the client produces. Anything else would be stored and then fail to
 *  decrypt later, which is a much worse way to find out. */
export function requireSealed(value: unknown, field: string, maxBytes = 380 * 1024): string {
  if (typeof value !== 'string' || !SEALED_PATTERN.test(value)) {
    throw badRequest(`${field} must be a sealed blob.`)
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw tooLarge(`${field} exceeds the maximum size of ${Math.floor(maxBytes / 1024)} KB.`)
  }
  return value
}

export interface Identity {
  publicKey: string
  wrappedPrivateKey: string
}

/** An account's identity key pair, as the client sends it: the public key in
 *  the clear and the private key sealed under the vault key, which the server
 *  cannot open. The public key is checked to be a real point on P-256, so a
 *  malformed key is refused here rather than breaking someone's share later.
 *  See decisions/0009. */
export async function requireIdentity(value: unknown): Promise<Identity> {
  if (!value || typeof value !== 'object') throw badRequest('identity must be an object.')
  const v = value as Record<string, unknown>
  const publicKey = requireBase64UrlBytes(v['publicKey'], PUBLIC_KEY_BYTES, 'identity.publicKey')
  if (!(await isValidPublicKey(new Uint8Array(Buffer.from(publicKey, 'base64url'))))) {
    throw badRequest('identity.publicKey is not a valid P-256 public key.')
  }
  const wrappedPrivateKey = requireSealed(v['wrappedPrivateKey'], 'identity.wrappedPrivateKey', 1024)
  return { publicKey, wrappedPrivateKey }
}

export interface KdfParams {
  algorithm: 'PBKDF2-HMAC-SHA256'
  iterations: number
  salt: string
}

/** The iteration floor is enforced here as well as in the client, because the
 *  client is the thing an attacker controls. A registration claiming 1,000
 *  iterations would weaken the vault against offline attack on the stored
 *  wrapped key. */
export const MIN_ITERATIONS = 600_000

export function requireKdf(value: unknown): KdfParams {
  const kdf = value as Partial<KdfParams> | undefined
  if (!kdf || typeof kdf !== 'object') throw badRequest('kdf is required.')
  if (kdf.algorithm !== 'PBKDF2-HMAC-SHA256') {
    throw badRequest('kdf.algorithm must be PBKDF2-HMAC-SHA256.')
  }
  if (typeof kdf.iterations !== 'number' || !Number.isInteger(kdf.iterations)) {
    throw badRequest('kdf.iterations must be an integer.')
  }
  if (kdf.iterations < MIN_ITERATIONS) {
    throw badRequest(`kdf.iterations must be at least ${MIN_ITERATIONS}.`)
  }
  return {
    algorithm: 'PBKDF2-HMAC-SHA256',
    iterations: kdf.iterations,
    salt: requireBase64UrlBytes(kdf.salt, 32, 'kdf.salt'),
  }
}
