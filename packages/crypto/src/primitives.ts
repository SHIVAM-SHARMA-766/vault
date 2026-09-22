// Thin wrappers over Web Crypto. Every primitive the vault uses comes from the
// platform implementation; nothing here implements an algorithm by hand.
//
// Web Crypto is reached through `globalThis.crypto.subtle`, which resolves to
// the browser's implementation in a page and to Node's in the API and in tests.

const subtle = (): SubtleCrypto => {
  const s = globalThis.crypto?.subtle
  if (!s) throw new Error('Web Crypto is unavailable in this environment')
  return s
}

/** A view whose backing buffer is a plain ArrayBuffer, which is what Web Crypto
 *  accepts. Copying also detaches the result from any caller-held buffer. */
function buf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

export type HashName = 'SHA-1' | 'SHA-256' | 'SHA-512'

export async function pbkdf2Sha256(
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  lengthBytes: number,
): Promise<Uint8Array> {
  if (iterations < 1) throw new Error('iterations must be at least 1')
  const key = await subtle().importKey('raw', buf(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await subtle().deriveBits(
    { name: 'PBKDF2', salt: buf(salt), iterations, hash: 'SHA-256' },
    key,
    lengthBytes * 8,
  )
  return new Uint8Array(bits)
}

export async function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  lengthBytes: number,
): Promise<Uint8Array> {
  const key = await subtle().importKey('raw', buf(ikm), 'HKDF', false, ['deriveBits'])
  const bits = await subtle().deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: buf(info) },
    key,
    lengthBytes * 8,
  )
  return new Uint8Array(bits)
}

export async function hmac(
  hash: HashName,
  key: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  const k = await subtle().importKey('raw', buf(key), { name: 'HMAC', hash }, false, ['sign'])
  return new Uint8Array(await subtle().sign('HMAC', k, buf(data)))
}

export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  return hmac('SHA-256', key, data)
}

export const GCM_IV_BYTES = 12
export const GCM_TAG_BYTES = 16

/** Returns ciphertext with the 16-byte authentication tag appended, which is
 *  how Web Crypto emits it. */
export async function aesGcmEncrypt(
  key: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  if (key.length !== 32) throw new Error('AES-256-GCM requires a 32-byte key')
  if (iv.length !== GCM_IV_BYTES) throw new Error(`IV must be ${GCM_IV_BYTES} bytes`)
  const k = await subtle().importKey('raw', buf(key), 'AES-GCM', false, ['encrypt'])
  const params: AesGcmParams = { name: 'AES-GCM', iv: buf(iv), tagLength: GCM_TAG_BYTES * 8 }
  if (aad) params.additionalData = buf(aad)
  return new Uint8Array(await subtle().encrypt(params, k, buf(plaintext)))
}

/** Throws if the tag does not verify. A caller must treat any failure as the
 *  data being wrong or tampered with, never as an empty result. */
export async function aesGcmDecrypt(
  key: Uint8Array,
  iv: Uint8Array,
  ciphertextAndTag: Uint8Array,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  if (key.length !== 32) throw new Error('AES-256-GCM requires a 32-byte key')
  if (iv.length !== GCM_IV_BYTES) throw new Error(`IV must be ${GCM_IV_BYTES} bytes`)
  const k = await subtle().importKey('raw', buf(key), 'AES-GCM', false, ['decrypt'])
  const params: AesGcmParams = { name: 'AES-GCM', iv: buf(iv), tagLength: GCM_TAG_BYTES * 8 }
  if (aad) params.additionalData = buf(aad)
  return new Uint8Array(await subtle().decrypt(params, k, buf(ciphertextAndTag)))
}
