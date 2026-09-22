// Every primitive asserted against test vectors published by the standards
// bodies that define it, not against values this package produced. A vector
// generated from our own implementation would pass whether or not the
// implementation is correct, and would make a second implementation — the
// planned Android client — agree with us rather than with the standard.

import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  fromHex,
  generateTotp,
  hkdfSha256,
  hmac,
  hmacSha256,
  pbkdf2Sha256,
  toHex,
  utf8Encode,
} from '../src/index.js'

function vectors<T>(file: string): T {
  return JSON.parse(readFileSync(new URL(`../../vectors/${file}`, import.meta.url), 'utf8')) as T
}

interface Meta { algorithm: string; source: string; note: string }

test('PBKDF2-HMAC-SHA256 matches RFC 7914 section 11', async () => {
  const v = vectors<Meta & {
    cases: { password: string; salt: string; iterations: number; dkLenBytes: number; derivedKeyHex: string }[]
  }>('pbkdf2-sha256.json')
  assert.equal(v.source, 'RFC 7914 section 11')
  assert.ok(v.cases.length > 0)
  for (const c of v.cases) {
    const got = await pbkdf2Sha256(
      utf8Encode(c.password), utf8Encode(c.salt), c.iterations, c.dkLenBytes,
    )
    assert.equal(toHex(got), c.derivedKeyHex, `PBKDF2 c=${c.iterations}`)
  }
})

test('HKDF-SHA256 matches RFC 5869 appendix A', async () => {
  const v = vectors<Meta & {
    cases: { case: string; ikmHex: string; saltHex: string; infoHex: string; okmLenBytes: number; okmHex: string }[]
  }>('hkdf-sha256.json')
  assert.equal(v.cases.length, 3)
  for (const c of v.cases) {
    const got = await hkdfSha256(
      fromHex(c.ikmHex), fromHex(c.saltHex), fromHex(c.infoHex), c.okmLenBytes,
    )
    assert.equal(toHex(got), c.okmHex, `HKDF ${c.case}`)
  }
})

test('HKDF-SHA256 handles the empty salt used by the key hierarchy', async () => {
  // Case A.3 is the one the key hierarchy actually relies on: the master key is
  // already the output of 600k salted PBKDF2 iterations, so HKDF extract is
  // given nothing further to work with.
  const v = vectors<Meta & { cases: { case: string; saltHex: string }[] }>('hkdf-sha256.json')
  const a3 = v.cases.find((c) => c.case === 'A.3')
  assert.ok(a3, 'A.3 vector present')
  assert.equal(a3.saltHex, '', 'A.3 is the empty-salt case')
})

test('HMAC-SHA256 matches RFC 4231', async () => {
  const v = vectors<Meta & { cases: { case: string; keyHex: string; dataHex: string; macHex: string }[] }>(
    'hmac-sha256.json',
  )
  for (const c of v.cases) {
    const got = await hmacSha256(fromHex(c.keyHex), fromHex(c.dataHex))
    assert.equal(toHex(got), c.macHex, `HMAC ${c.case}`)
  }
})

test('AES-256-GCM matches the GCM specification test cases', async () => {
  const v = vectors<Meta & {
    cases: { case: string; keyHex: string; ivHex: string; plaintextHex: string; aadHex: string; ciphertextHex: string; tagHex: string }[]
  }>('aes-256-gcm.json')
  for (const c of v.cases) {
    const key = fromHex(c.keyHex)
    const iv = fromHex(c.ivHex)
    const pt = fromHex(c.plaintextHex)
    const aad = c.aadHex ? fromHex(c.aadHex) : undefined

    const sealed = await aesGcmEncrypt(key, iv, pt, aad)
    assert.equal(toHex(sealed), c.ciphertextHex + c.tagHex, `${c.case} encrypt`)

    const opened = await aesGcmDecrypt(key, iv, sealed, aad)
    assert.equal(toHex(opened), c.plaintextHex, `${c.case} decrypt`)
  }
})

test('AES-256-GCM rejects a tampered tag', async () => {
  const key = new Uint8Array(32)
  const iv = new Uint8Array(12)
  const sealed = await aesGcmEncrypt(key, iv, utf8Encode('secret'))
  sealed[sealed.length - 1] = sealed[sealed.length - 1]! ^ 0x01
  await assert.rejects(() => aesGcmDecrypt(key, iv, sealed))
})

test('AES-256-GCM rejects the wrong additional data', async () => {
  const key = new Uint8Array(32)
  const iv = new Uint8Array(12)
  const sealed = await aesGcmEncrypt(key, iv, utf8Encode('secret'), utf8Encode('entry:a'))
  await assert.rejects(() => aesGcmDecrypt(key, iv, sealed, utf8Encode('entry:b')))
})

test('TOTP matches RFC 6238 appendix B across all three hash functions', async () => {
  const v = vectors<Meta & {
    cases: { algorithm: string; secretAscii: string; timeSeconds: number; periodSeconds: number; digits: number; code: string }[]
  }>('totp.json')
  assert.equal(v.cases.length, 18, 'six timestamps across three hash functions')

  for (const c of v.cases) {
    // RFC 6238 publishes ASCII seeds; real secrets are base32, so the vector's
    // seed is re-encoded through the same path a stored secret takes.
    const { toBase32Secret } = await import('../src/index.js')
    const got = await generateTotp(
      toBase32Secret(utf8Encode(c.secretAscii)),
      c.timeSeconds * 1000,
      { algorithm: c.algorithm as 'SHA-1' | 'SHA-256' | 'SHA-512', digits: c.digits, period: c.periodSeconds },
    )
    assert.equal(got.code, c.code, `TOTP ${c.algorithm} T=${c.timeSeconds}`)
  }
})

test('HMAC supports every hash the TOTP vectors exercise', async () => {
  for (const h of ['SHA-1', 'SHA-256', 'SHA-512'] as const) {
    const mac = await hmac(h, utf8Encode('k'), utf8Encode('d'))
    assert.ok(mac.length > 0, `${h} produced output`)
  }
})
