// Argument guards. A wrong-sized key or IV reaching AES-GCM is a programming
// error that must fail loudly at the call site, not produce ciphertext nobody
// can decrypt later.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  GCM_IV_BYTES,
  aesGcmDecrypt,
  aesGcmEncrypt,
  hkdfSha256,
  pbkdf2Sha256,
  randomBytes,
  toHex,
  utf8Encode,
} from '../src/index.js'

test('AES-GCM rejects a key that is not 256 bits', async () => {
  const iv = new Uint8Array(GCM_IV_BYTES)
  for (const size of [16, 24, 31, 33]) {
    await assert.rejects(
      () => aesGcmEncrypt(new Uint8Array(size), iv, utf8Encode('x')),
      /32-byte key/,
      `rejected ${size}-byte key on encrypt`,
    )
    await assert.rejects(
      () => aesGcmDecrypt(new Uint8Array(size), iv, new Uint8Array(32)),
      /32-byte key/,
      `rejected ${size}-byte key on decrypt`,
    )
  }
})

test('AES-GCM rejects an IV that is not 96 bits', async () => {
  const key = new Uint8Array(32)
  for (const size of [8, 11, 13, 16]) {
    await assert.rejects(
      () => aesGcmEncrypt(key, new Uint8Array(size), utf8Encode('x')),
      /IV must be 12 bytes/,
    )
    await assert.rejects(
      () => aesGcmDecrypt(key, new Uint8Array(size), new Uint8Array(32)),
      /IV must be 12 bytes/,
    )
  }
})

test('AES-GCM encrypts with and without additional data', async () => {
  const key = randomBytes(32)
  const iv = randomBytes(GCM_IV_BYTES)
  const withAad = await aesGcmEncrypt(key, iv, utf8Encode('x'), utf8Encode('context'))
  const without = await aesGcmEncrypt(key, iv, utf8Encode('x'))
  assert.notEqual(toHex(withAad), toHex(without), 'the tag covers the additional data')
})

test('PBKDF2 rejects a zero iteration count', async () => {
  await assert.rejects(
    () => pbkdf2Sha256(utf8Encode('pw'), new Uint8Array(16), 0, 32),
    /at least 1/,
  )
})

test('HKDF produces the requested length, including lengths past one block', async () => {
  const ikm = randomBytes(32)
  for (const n of [1, 32, 64, 100]) {
    const out = await hkdfSha256(ikm, new Uint8Array(0), utf8Encode('info'), n)
    assert.equal(out.length, n)
  }
})

test('HKDF labels are domain-separated', async () => {
  const ikm = randomBytes(32)
  const a = await hkdfSha256(ikm, new Uint8Array(0), utf8Encode('label.a'), 32)
  const b = await hkdfSha256(ikm, new Uint8Array(0), utf8Encode('label.b'), 32)
  assert.notEqual(toHex(a), toHex(b))
})
