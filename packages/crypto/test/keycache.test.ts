// The imported-key cache must never let a wiped or changed key keep working.

import test from 'node:test'
import assert from 'node:assert/strict'

import { UnsealError, generateVaultKey, seal, unseal, wipe } from '../src/index.js'

test('a wiped key no longer decrypts, even though its import was cached', async () => {
  const key = generateVaultKey()
  const blob = await seal(key, new Uint8Array([1, 2, 3]))
  assert.deepEqual(await unseal(key, blob), new Uint8Array([1, 2, 3]))
  wipe(key)
  await assert.rejects(unseal(key, blob), UnsealError)
})

test('a buffer refilled with another key decrypts only with the new contents', async () => {
  const a = generateVaultKey()
  const b = generateVaultKey()
  const buf = new Uint8Array(a)
  const blobA = await seal(buf, new Uint8Array([7]))
  buf.set(b)
  await assert.rejects(unseal(buf, blobA), UnsealError, 'the cached key for the old contents is not used')
  assert.deepEqual(await unseal(b, await seal(buf, new Uint8Array([9]))), new Uint8Array([9]))
})
