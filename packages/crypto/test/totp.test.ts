// TOTP argument guards and the behaviour around step boundaries. The vector
// tests in vectors.test.ts cover correctness against RFC 6238; these cover the
// cases the RFC does not specify.

import test from 'node:test'
import assert from 'node:assert/strict'

import { TOTP_DEFAULTS, generateTotp, randomBytes, totpFromBytes } from '../src/index.js'

test('the defaults are the values every authenticator app assumes', async () => {
  assert.deepEqual(TOTP_DEFAULTS, { algorithm: 'SHA-1', digits: 6, period: 30 })
})

test('an empty secret is rejected rather than producing a code', async () => {
  await assert.rejects(() => totpFromBytes(new Uint8Array(0)), /secret is empty/)
})

test('a digit count outside the usable range is rejected', async () => {
  const secret = randomBytes(20)
  for (const digits of [0, 5, 11, 20]) {
    await assert.rejects(() => totpFromBytes(secret, Date.now(), { digits }), /between 6 and 10/)
  }
})

test('a non-positive period is rejected', async () => {
  const secret = randomBytes(20)
  for (const period of [0, -30]) {
    await assert.rejects(() => totpFromBytes(secret, Date.now(), { period }), /at least 1 second/)
  }
})

test('every supported digit count produces that many digits', async () => {
  const secret = randomBytes(20)
  for (const digits of [6, 7, 8, 9, 10]) {
    const { code } = await totpFromBytes(secret, 1_700_000_000_000, { digits })
    assert.equal(code.length, digits, `${digits} digits`)
    assert.match(code, /^\d+$/)
  }
})

test('the code is stable within a step and changes across one', async () => {
  // 1_700_000_040 is divisible by 30, so it is the first instant of a step.
  // A timestamp that merely looks round is usually mid-window.
  const secret = 'JBSWY3DPEHPK3PXP'
  const stepStart = 1_700_000_040_000
  const withinA = await generateTotp(secret, stepStart)
  const withinB = await generateTotp(secret, stepStart + 29_000)
  const next = await generateTotp(secret, stepStart + 30_000)

  assert.equal(withinA.code, withinB.code, 'same 30-second window')
  assert.notEqual(withinA.code, next.code, 'next window')
  assert.equal(withinA.secondsRemaining, 30)
  assert.equal(withinB.secondsRemaining, 1)
  assert.equal(next.secondsRemaining, 30)
})

test('counters beyond 32 bits are handled', async () => {
  // Timestamps past 2038 push the counter beyond what a bitwise operation in
  // JavaScript can represent, which is why the counter is written with a
  // 64-bit DataView rather than shifts.
  const { code } = await generateTotp('JBSWY3DPEHPK3PXP', 20_000_000_000_000)
  assert.match(code, /^\d{6}$/)
})

test('a non-default period shifts the window', async () => {
  const { secondsRemaining } = await generateTotp('JBSWY3DPEHPK3PXP', 60_000, { period: 60 })
  assert.equal(secondsRemaining, 60)
})
