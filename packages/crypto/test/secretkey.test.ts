// The secret key (decisions/0027): format, checksum, and known-answer
// derivation. The vectors below were computed independently with Python's
// hashlib (PBKDF2, HMAC-based HKDF), not with this package.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SecretKeyFormatError,
  UnsealError,
  changePassword,
  createAccount,
  deriveLoginKeys,
  deriveMasterKey,
  formatSecretKey,
  fromBase64Url,
  generateSecretKey,
  parseSecretKey,
  toHex,
  unlock,
  unlockWithRecoveryKey,
  unwrapVaultKey,
} from '../src/index.js'

const FAST = 1_000
const SK = Uint8Array.from({ length: 16 }, (_, i) => i)
const SK_TEXT = 'SK1-000G-40R4-0M30-E209-185G-R38E-1YZ4-BJS6'

test('known answer: the master key without and with a secret key', async () => {
  const salt = new Uint8Array(32)
  const v1 = await deriveMasterKey('correct horse battery staple', salt, FAST)
  assert.equal(toHex(v1), 'd893f6de5e5e7054ba2f34f264c22ec4ffabccff3bfe1a9cac76ab7cdb18f4ca')
  const v2 = await deriveMasterKey('correct horse battery staple', salt, FAST, SK)
  assert.equal(toHex(v2), 'be46dacaf481f200831f492ad68b540b09e3f85fde5bb5895b3de2102b063009')
})

test('the written form round-trips, forgives case and grouping, and catches typos', async () => {
  assert.equal(await formatSecretKey(SK), SK_TEXT)
  assert.deepEqual(await parseSecretKey(SK_TEXT), SK)
  assert.deepEqual(await parseSecretKey(SK_TEXT.toLowerCase().replace(/-/g, ' ')), SK)
  assert.deepEqual(await parseSecretKey(SK_TEXT.slice(4)), SK, 'the prefix is optional')
  const typo = SK_TEXT.slice(0, -1) + (SK_TEXT.endsWith('6') ? '7' : '6')
  await assert.rejects(parseSecretKey(typo), SecretKeyFormatError)
  await assert.rejects(parseSecretKey('SK1-000G'), SecretKeyFormatError)
  await assert.rejects(parseSecretKey(''), SecretKeyFormatError)
  const fresh = generateSecretKey()
  assert.deepEqual(await parseSecretKey(await formatSecretKey(fresh)), fresh)
})

test('an account with a secret key opens only with it, and the recovery key still works', async () => {
  const account = await createAccount('a-long-enough-master-password', FAST, SK)
  assert.equal(account.kdf.version, 2)
  const salt = fromBase64Url(account.kdf.salt)
  const opened = await unlock('a-long-enough-master-password', account.kdf, account.wrappedVaultKey, salt, SK)
  assert.deepEqual(opened.vaultKey, account.vaultKey)
  assert.equal(opened.authKey, account.authKey)

  await assert.rejects(unlock('a-long-enough-master-password', account.kdf, account.wrappedVaultKey, salt), /secret key/)
  const wrongKey = new Uint8Array(16).fill(9)
  await assert.rejects(unlock('a-long-enough-master-password', account.kdf, account.wrappedVaultKey, salt, wrongKey), UnsealError)
  const withoutSk = await deriveLoginKeys('a-long-enough-master-password', salt, FAST)
  assert.notEqual(withoutSk.authKey, account.authKey, 'the auth key depends on the secret key')

  assert.deepEqual(await unlockWithRecoveryKey(account.recoveryKey, account.wrappedVaultKeyForRecovery), account.vaultKey)
})

test('turning the secret key on and off re-wraps the same vault key', async () => {
  const account = await createAccount('a-long-enough-master-password', FAST)
  assert.equal(account.kdf.version, undefined)
  const on = await changePassword('a-long-enough-master-password', account.vaultKey, FAST, SK)
  assert.equal(on.kdf.version, 2)
  const keysOn = await deriveLoginKeys('a-long-enough-master-password', fromBase64Url(on.kdf.salt), FAST, SK)
  assert.equal(keysOn.authKey, on.authKey)
  assert.deepEqual(await unwrapVaultKey(on.wrappedVaultKey, keysOn.kek, 'master'), account.vaultKey)

  const off = await changePassword('a-long-enough-master-password', account.vaultKey, FAST)
  assert.equal(off.kdf.version, undefined)
  const keysOff = await deriveLoginKeys('a-long-enough-master-password', fromBase64Url(off.kdf.salt), FAST)
  assert.deepEqual(await unwrapVaultKey(off.wrappedVaultKey, keysOff.kek, 'master'), account.vaultKey)
})
