// The sealed-blob format. Every ciphertext the vault stores is a string in this
// shape, and nothing outside this file constructs or parses one.
//
//     v1.<base64url(iv)>.<base64url(ciphertext || tag)>
//
// The version prefix is what allows the scheme to change later: a v2 using a
// different cipher can be introduced while v1 blobs remain readable, which is
// the only way to migrate data that is already encrypted.

import { fromBase64Url, toBase64Url, utf8Decode, utf8Encode } from './encoding.js'
import { GCM_IV_BYTES, aesGcmDecrypt, aesGcmEncrypt } from './primitives.js'
import { randomBytes } from './random.js'

export const SEALED_VERSION = 'v1'

/** Raised for every failure to unseal, whatever the cause. The message never
 *  distinguishes a malformed blob from a failed authentication tag, because
 *  that distinction is occasionally useful to an attacker and never useful to
 *  a user. */
export class UnsealError extends Error {
  constructor(message = 'unable to decrypt') {
    super(message)
    this.name = 'UnsealError'
  }
}

/** Encrypt under AES-256-GCM with a fresh random IV.
 *
 *  `aad` is authenticated but not encrypted. Callers pass the identity of the
 *  thing being sealed — an entry id, a key's purpose — so that a server holding
 *  the ciphertext cannot move a blob to a different identity without the
 *  tag failing. */
export async function seal(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): Promise<string> {
  const iv = randomBytes(GCM_IV_BYTES)
  const sealed = await aesGcmEncrypt(key, iv, plaintext, aad)
  return `${SEALED_VERSION}.${toBase64Url(iv)}.${toBase64Url(sealed)}`
}

export async function unseal(
  key: Uint8Array,
  blob: string,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  const parts = blob.split('.')
  if (parts.length !== 3) throw new UnsealError()
  const [version, ivB64, bodyB64] = parts as [string, string, string]
  if (version !== SEALED_VERSION) {
    throw new UnsealError(`unsupported ciphertext version: ${version}`)
  }
  let iv: Uint8Array
  let body: Uint8Array
  try {
    iv = fromBase64Url(ivB64)
    body = fromBase64Url(bodyB64)
  } catch {
    throw new UnsealError()
  }
  if (iv.length !== GCM_IV_BYTES) throw new UnsealError()
  try {
    return await aesGcmDecrypt(key, iv, body, aad)
  } catch {
    throw new UnsealError()
  }
}

export async function sealString(
  key: Uint8Array,
  plaintext: string,
  aad?: Uint8Array,
): Promise<string> {
  return seal(key, utf8Encode(plaintext), aad)
}

export async function unsealString(
  key: Uint8Array,
  blob: string,
  aad?: Uint8Array,
): Promise<string> {
  try {
    return utf8Decode(await unseal(key, blob, aad))
  } catch (err) {
    if (err instanceof UnsealError) throw err
    throw new UnsealError()
  }
}

export async function sealJson<T>(key: Uint8Array, value: T, aad?: Uint8Array): Promise<string> {
  return sealString(key, JSON.stringify(value), aad)
}

export async function unsealJson<T>(key: Uint8Array, blob: string, aad?: Uint8Array): Promise<T> {
  const text = await unsealString(key, blob, aad)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new UnsealError()
  }
}
