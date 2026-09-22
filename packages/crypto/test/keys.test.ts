// Properties of the key hierarchy. These assert the claims decisions/0001 makes
// about the design, so that a change which quietly breaks one of them fails
// here rather than in production.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  UnsealError,
  changePassword,
  createAccount,
  deriveAuthKey,
  deriveKek,
  deriveMasterKey,
  fromBase64Url,
  generateVaultKey,
  normalizeEmail,
  parseRecoveryKey,
  rotateRecoveryKey,
  toBase64Url,
  toHex,
  unlock,
  unlockWithRecoveryKey,
  unwrapVaultKey,
  wrapVaultKey,
} from '../src/index.js'

// 600k PBKDF2 iterations take roughly a second each; tests that only exercise
// structure use a low count deliberately. Anything asserting the production
// parameter says so explicitly.
const FAST = 1_000

test('the auth branch reveals nothing about the encryption branch', async () => {
  const masterKey = await deriveMasterKey('correct horse battery staple', new Uint8Array(32), FAST)
  const kek = await deriveKek(masterKey)
  const authKey = await deriveAuthKey(masterKey)

  assert.notEqual(toHex(kek), toHex(authKey))
  assert.equal(kek.length, 32)
  assert.equal(authKey.length, 32)
})

test('the same password and salt derive the same keys', async () => {
  const salt = new Uint8Array(32).fill(7)
  const a = await deriveMasterKey('pw', salt, FAST)
  const b = await deriveMasterKey('pw', salt, FAST)
  assert.equal(toHex(a), toHex(b))
})

test('a different salt derives a different key from the same password', async () => {
  const a = await deriveMasterKey('pw', new Uint8Array(32).fill(1), FAST)
  const b = await deriveMasterKey('pw', new Uint8Array(32).fill(2), FAST)
  assert.notEqual(toHex(a), toHex(b))
})

test('registration produces a salt, an auth key, and two wrapped copies of the vault key', async () => {
  const account = await createAccount('a-long-enough-master-password', FAST)

  assert.equal(account.kdf.algorithm, 'PBKDF2-HMAC-SHA256')
  assert.equal(fromBase64Url(account.kdf.salt).length, 32)
  assert.equal(fromBase64Url(account.authKey).length, 32)
  assert.equal(account.vaultKey.length, 32)
  assert.ok(account.wrappedVaultKey.startsWith('v1.'))
  assert.ok(account.wrappedVaultKeyForRecovery.startsWith('v1.'))

  // Two wrappings of one key, under different KEKs, so the blobs must differ.
  assert.notEqual(account.wrappedVaultKey, account.wrappedVaultKeyForRecovery)
})

test('the correct password unlocks and recovers the same vault key', async () => {
  const account = await createAccount('a-long-enough-master-password', FAST)
  const opened = await unlock(
    'a-long-enough-master-password',
    account.kdf,
    account.wrappedVaultKey,
    fromBase64Url(account.kdf.salt),
  )
  assert.equal(toHex(opened.vaultKey), toHex(account.vaultKey))
  assert.equal(opened.authKey, account.authKey)
})

test('a wrong password fails locally, without asking the server', async () => {
  const account = await createAccount('a-long-enough-master-password', FAST)
  await assert.rejects(
    () => unlock('wrong-password', account.kdf, account.wrappedVaultKey, fromBase64Url(account.kdf.salt)),
    UnsealError,
  )
})

test('the recovery key opens the vault without the master password', async () => {
  const account = await createAccount('a-long-enough-master-password', FAST)
  const recovered = await unlockWithRecoveryKey(
    account.recoveryKey,
    account.wrappedVaultKeyForRecovery,
  )
  assert.equal(toHex(recovered), toHex(account.vaultKey))
})

test('the recovery key survives being retyped by a human', async () => {
  const account = await createAccount('a-long-enough-master-password', FAST)
  // Crockford substitutions plus a plausible transcription: lower case, spaces
  // instead of hyphens.
  const retyped = account.recoveryKey.toLowerCase().replace(/-/g, ' ')
  const recovered = await unlockWithRecoveryKey(retyped, account.wrappedVaultKeyForRecovery)
  assert.equal(toHex(recovered), toHex(account.vaultKey))
  assert.equal(parseRecoveryKey(account.recoveryKey).length, 32)
})

test('a wrong recovery key fails', async () => {
  const account = await createAccount('a-long-enough-master-password', FAST)
  await assert.rejects(
    () => unlockWithRecoveryKey('0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0', account.wrappedVaultKeyForRecovery),
    UnsealError,
  )
})

test('the master and recovery wrappings cannot be substituted for each other', async () => {
  // Both blobs wrap the same key; the additional authenticated data is what
  // stops a server from serving one in place of the other.
  const account = await createAccount('a-long-enough-master-password', FAST)
  const masterKey = await deriveMasterKey('a-long-enough-master-password', fromBase64Url(account.kdf.salt), FAST)
  const kek = await deriveKek(masterKey)

  await assert.rejects(
    () => unwrapVaultKey(account.wrappedVaultKeyForRecovery, kek, 'master'),
    UnsealError,
  )
})

test('changing the master password leaves the vault key untouched', async () => {
  // The central claim of decisions/0001: a password change rewraps one key and
  // re-encrypts nothing, so no entry is rewritten and history survives.
  const account = await createAccount('first-master-password', FAST)
  const changed = await changePassword('second-master-password', account.vaultKey, FAST)

  assert.notEqual(changed.kdf.salt, account.kdf.salt, 'a fresh salt is issued')
  assert.notEqual(changed.authKey, account.authKey, 'the server-facing value changes')

  const opened = await unlock(
    'second-master-password',
    changed.kdf,
    changed.wrappedVaultKey,
    fromBase64Url(changed.kdf.salt),
  )
  assert.equal(toHex(opened.vaultKey), toHex(account.vaultKey), 'same vault key as before')
})

test('the old password stops working after a change', async () => {
  const account = await createAccount('first-master-password', FAST)
  const changed = await changePassword('second-master-password', account.vaultKey, FAST)
  await assert.rejects(
    () => unlock('first-master-password', changed.kdf, changed.wrappedVaultKey, fromBase64Url(changed.kdf.salt)),
    UnsealError,
  )
})

test('the recovery key still works after a password change', async () => {
  // The recovery wrapping is derived from the recovery key alone, so it is
  // unaffected by the master password. Losing this property would silently
  // strand the user's only backup.
  const account = await createAccount('first-master-password', FAST)
  await changePassword('second-master-password', account.vaultKey, FAST)
  const recovered = await unlockWithRecoveryKey(account.recoveryKey, account.wrappedVaultKeyForRecovery)
  assert.equal(toHex(recovered), toHex(account.vaultKey))
})

test('rotating the recovery key invalidates the previous one', async () => {
  const account = await createAccount('a-long-enough-master-password', FAST)
  const rotated = await rotateRecoveryKey(account.vaultKey)

  assert.notEqual(rotated.recoveryKey, account.recoveryKey)
  const viaNew = await unlockWithRecoveryKey(rotated.recoveryKey, rotated.wrappedVaultKeyForRecovery)
  assert.equal(toHex(viaNew), toHex(account.vaultKey))

  await assert.rejects(
    () => unlockWithRecoveryKey(account.recoveryKey, rotated.wrappedVaultKeyForRecovery),
    UnsealError,
  )
})

test('wrapping is randomised, so the same key wraps to different blobs', async () => {
  const vaultKey = generateVaultKey()
  const kek = new Uint8Array(32).fill(9)
  const a = await wrapVaultKey(vaultKey, kek, 'master')
  const b = await wrapVaultKey(vaultKey, kek, 'master')
  assert.notEqual(a, b, 'fresh IV per wrap')
  assert.equal(toHex(await unwrapVaultKey(a, kek, 'master')), toHex(vaultKey))
  assert.equal(toHex(await unwrapVaultKey(b, kek, 'master')), toHex(vaultKey))
})

test('email normalisation is case and whitespace insensitive', async () => {
  assert.equal(normalizeEmail('  Person@Example.COM '), 'person@example.com')
})

test('unicode passwords normalise so that identical text derives identical keys', async () => {
  // The same character can be typed as one code point or as a base plus a
  // combining mark. Without NFKC these derive different keys and the user is
  // locked out depending on which keyboard they used.
  const salt = new Uint8Array(32).fill(3)
  const composed = await deriveMasterKey('paßwort-é', salt, FAST)
  const decomposed = await deriveMasterKey('paßwort-é', salt, FAST)
  assert.equal(toHex(composed), toHex(decomposed))
})

test('the production iteration count is the OWASP floor', async () => {
  const { PBKDF2_ITERATIONS } = await import('../src/index.js')
  assert.equal(PBKDF2_ITERATIONS, 600_000)
  const account = await createAccount('a-long-enough-master-password')
  assert.equal(account.kdf.iterations, 600_000)
  assert.equal(toBase64Url(fromBase64Url(account.kdf.salt)), account.kdf.salt)
})

test('the recovery key can prove itself without revealing its KEK', async () => {
  // Recovery is used when the master password is gone, so the usual auth key
  // cannot be produced. The server still must not hand the recovery-wrapped
  // vault key to an unauthenticated caller, so the recovery key gets its own
  // authentication branch — separate from the branch that unwraps the vault.
  const { deriveRecoveryAuthKey, deriveRecoveryKek, deriveRecoveryProof, parseRecoveryKey: parse } =
    await import('../src/index.js')

  const account = await createAccount('a-long-enough-master-password', FAST)
  const bytes = parse(account.recoveryKey)

  const authBranch = await deriveRecoveryAuthKey(bytes)
  const kekBranch = await deriveRecoveryKek(bytes)
  assert.notEqual(toHex(authBranch), toHex(kekBranch), 'the two branches differ')

  // What the client sends at recovery time must match what was stored at signup.
  assert.equal(await deriveRecoveryProof(account.recoveryKey), account.recoveryAuthKey)
})

test('a recovery proof is reproducible from a retyped key', async () => {
  const { deriveRecoveryProof } = await import('../src/index.js')
  const account = await createAccount('a-long-enough-master-password', FAST)
  const retyped = account.recoveryKey.toLowerCase().replace(/-/g, ' ')
  assert.equal(await deriveRecoveryProof(retyped), account.recoveryAuthKey)
})

test('rotating the recovery key also rotates its proof', async () => {
  const account = await createAccount('a-long-enough-master-password', FAST)
  const rotated = await rotateRecoveryKey(account.vaultKey)
  assert.notEqual(rotated.recoveryAuthKey, account.recoveryAuthKey)

  const { deriveRecoveryProof } = await import('../src/index.js')
  assert.equal(await deriveRecoveryProof(rotated.recoveryKey), rotated.recoveryAuthKey)
})
