// Encoding round-trips, and the transcription tolerance the recovery key needs.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  fromBase32Secret,
  fromBase64Url,
  fromHex,
  fromRecoveryString,
  generateTotp,
  parseOtpauthUri,
  randomBytes,
  timingSafeEqual,
  toBase32Secret,
  toBase64Url,
  toHex,
  toRecoveryString,
  utf8Decode,
  utf8Encode,
  wipe,
} from '../src/index.js'

test('base64url round-trips every input length', async () => {
  for (let n = 0; n <= 64; n++) {
    const bytes = randomBytes(n || 1).slice(0, n)
    assert.deepEqual(fromBase64Url(toBase64Url(bytes)), bytes, `length ${n}`)
  }
})

test('base64url output is URL-safe and unpadded', async () => {
  for (let i = 0; i < 50; i++) {
    assert.match(toBase64Url(randomBytes(20)), /^[A-Za-z0-9_-]*$/)
  }
})

test('hex round-trips and rejects malformed input', async () => {
  const bytes = randomBytes(32)
  assert.deepEqual(fromHex(toHex(bytes)), bytes)
  assert.throws(() => fromHex('abc'), /even length/)
  assert.throws(() => fromHex('zz'), /invalid hex/)
})

test('utf8 round-trips and rejects invalid byte sequences', async () => {
  assert.equal(utf8Decode(utf8Encode('héllo 🔐')), 'héllo 🔐')
  assert.throws(() => utf8Decode(new Uint8Array([0xff, 0xfe])))
})

test('a recovery key is grouped for transcription', async () => {
  const formatted = toRecoveryString(randomBytes(32))
  assert.match(formatted, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{1,4})+$/)
  assert.ok(!/[ILOU]/.test(formatted), 'Crockford omits the ambiguous letters')
})

test('a recovery key survives the ways people retype it', async () => {
  const bytes = randomBytes(32)
  const formatted = toRecoveryString(bytes)
  const variants = [
    formatted,
    formatted.toLowerCase(),
    formatted.replace(/-/g, ''),
    formatted.replace(/-/g, ' '),
    `  ${formatted}  `,
  ]
  for (const v of variants) {
    assert.deepEqual(fromRecoveryString(v), bytes, `variant: ${v.slice(0, 12)}...`)
  }
})

test('the Crockford lookalike substitutions are applied', async () => {
  // Someone reading a printed key cannot tell 1 from I or 0 from O, so both
  // spellings have to decode identically.
  assert.deepEqual(fromRecoveryString('1111'), fromRecoveryString('IIII'))
  assert.deepEqual(fromRecoveryString('1111'), fromRecoveryString('llll'))
  assert.deepEqual(fromRecoveryString('0000'), fromRecoveryString('OOOO'))
})

test('an empty or invalid recovery key is rejected', async () => {
  assert.throws(() => fromRecoveryString(''), /empty/)
  assert.throws(() => fromRecoveryString('!!!!'), /invalid base32/)
})

test('base32 TOTP secrets round-trip and tolerate real-world formatting', async () => {
  const bytes = randomBytes(20)
  assert.deepEqual(fromBase32Secret(toBase32Secret(bytes)), bytes)
  // Padding, spacing, and lower case all appear in secrets copied from other apps.
  const canonical = fromBase32Secret('JBSWY3DPEHPK3PXP')
  assert.deepEqual(fromBase32Secret('jbswy3dp ehpk3pxp'), canonical)
  assert.deepEqual(fromBase32Secret('JBSWY3DPEHPK3PXP===='), canonical)
})

test('the two base32 alphabets are not interchangeable', async () => {
  // Crockford and RFC 4648 share characters but not their values; decoding a
  // TOTP secret as a recovery key must not silently produce different bytes.
  assert.notDeepEqual(fromBase32Secret('ABCD'), fromRecoveryString('ABCD'))
})

test('a known TOTP secret produces a stable code', async () => {
  const at = 1_700_000_000_000
  const a = await generateTotp('JBSWY3DPEHPK3PXP', at)
  const b = await generateTotp('jbswy3dp-ehpk3pxp', at)
  assert.equal(a.code, b.code)
  assert.match(a.code, /^\d{6}$/)
  assert.ok(a.secondsRemaining > 0 && a.secondsRemaining <= 30)
})

test('the TOTP countdown reaches zero at a step boundary', async () => {
  const atBoundary = await generateTotp('JBSWY3DPEHPK3PXP', 30_000)
  assert.equal(atBoundary.secondsRemaining, 30)
  const justBefore = await generateTotp('JBSWY3DPEHPK3PXP', 59_000)
  assert.equal(justBefore.secondsRemaining, 1)
})

test('otpauth URIs are parsed, with RFC defaults for anything absent', async () => {
  const full = parseOtpauthUri(
    'otpauth://totp/GitHub:person@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&algorithm=SHA256&digits=8&period=60',
  )
  assert.equal(full.secret, 'JBSWY3DPEHPK3PXP')
  assert.equal(full.issuer, 'GitHub')
  assert.equal(full.account, 'person@example.com')
  assert.deepEqual(full.config, { algorithm: 'SHA-256', digits: 8, period: 60 })

  const minimal = parseOtpauthUri('otpauth://totp/person@example.com?secret=JBSWY3DPEHPK3PXP')
  assert.deepEqual(minimal.config, { algorithm: 'SHA-1', digits: 6, period: 30 })
})

test('malformed otpauth URIs are rejected', async () => {
  assert.throws(() => parseOtpauthUri('nonsense'), /valid otpauth/)
  assert.throws(() => parseOtpauthUri('https://example.com'), /not an otpauth/)
  assert.throws(() => parseOtpauthUri('otpauth://hotp/x?secret=A'), /only TOTP/)
  assert.throws(() => parseOtpauthUri('otpauth://totp/x'), /no secret/)
})

test('timing-safe comparison agrees with equality', async () => {
  const a = randomBytes(32)
  assert.ok(timingSafeEqual(a, Uint8Array.from(a)))
  const b = Uint8Array.from(a)
  b[31] = b[31]! ^ 0x01
  assert.ok(!timingSafeEqual(a, b))
  assert.ok(!timingSafeEqual(a, a.slice(0, 31)), 'differing lengths are unequal')
})

test('wipe clears key material in place', async () => {
  const key = randomBytes(32)
  wipe(key)
  assert.ok(key.every((b) => b === 0))
})

test('randomBytes rejects nonsensical lengths', async () => {
  assert.throws(() => randomBytes(0), /positive integer/)
  assert.throws(() => randomBytes(-1), /positive integer/)
  assert.throws(() => randomBytes(1.5), /positive integer/)
})

test('randomBytes does not repeat', async () => {
  const seen = new Set<string>()
  for (let i = 0; i < 100; i++) seen.add(toHex(randomBytes(16)))
  assert.equal(seen.size, 100)
})
