// The account password's proof (decisions/0036).

import test from 'node:test'
import assert from 'node:assert/strict'

import { ACCOUNT_KDF, deriveAccountProof, deriveMasterKey, fromBase64Url, newAccountParams, toBase64Url, toHex } from '../src/index.js'

test('the proof is stable, salted, and unrelated to the master key from the same text', async () => {
  const params = { ...ACCOUNT_KDF, salt: toBase64Url(new Uint8Array(16).fill(4)) }
  const a = await deriveAccountProof('same text for both', params)
  assert.equal(a, await deriveAccountProof('same text for both', params))
  assert.equal(fromBase64Url(a).length, 32)
  assert.notEqual(a, await deriveAccountProof('same text for both', { ...params, salt: toBase64Url(new Uint8Array(16).fill(5)) }))
  const master = await deriveMasterKey('same text for both', new Uint8Array(32).fill(4))
  assert.notEqual(toHex(fromBase64Url(a)), toHex(master))
  const fresh = newAccountParams()
  assert.deepEqual({ m: fresh.m, t: fresh.t, p: fresh.p }, ACCOUNT_KDF)
  assert.equal(fromBase64Url(fresh.salt).length, 16)
})
