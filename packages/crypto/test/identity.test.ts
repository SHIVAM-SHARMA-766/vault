// Identity keys and sealing to a recipient. These assert the properties
// decisions/0009 relies on: only the recipient can open, the context is bound,
// the recipient is bound, tampering fails closed, and the private key is as
// protected as the vault.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  IDENTITY_VERSION,
  PUBLIC_KEY_BYTES,
  UnsealError,
  generateIdentityKeyPair,
  generateVaultKey,
  identityFingerprint,
  isValidPublicKey,
  openFromSender,
  sealForRecipient,
  toBase64Url,
  unwrapIdentityPrivateKey,
  utf8Decode,
  utf8Encode,
  wrapIdentityPrivateKey,
} from '../src/index.js'

const secret = utf8Encode('a collection key, say')

test('a key pair has a 65-byte uncompressed public key', async () => {
  const kp = await generateIdentityKeyPair()
  assert.equal(kp.publicKey.length, PUBLIC_KEY_BYTES)
  assert.equal(kp.publicKey[0], 0x04)
  assert.ok(kp.privateKey.length > 100)
  assert.equal(await isValidPublicKey(kp.publicKey), true)
})

test('the recipient opens what was sealed to them', async () => {
  const bob = await generateIdentityKeyPair()
  const blob = await sealForRecipient(bob.publicKey, secret, 'collection-key:c1')
  assert.ok(blob.startsWith(`${IDENTITY_VERSION}.`))
  const opened = await openFromSender(bob.privateKey, bob.publicKey, blob, 'collection-key:c1')
  assert.equal(utf8Decode(opened), 'a collection key, say')
})

test('someone else cannot open it', async () => {
  const bob = await generateIdentityKeyPair()
  const eve = await generateIdentityKeyPair()
  const blob = await sealForRecipient(bob.publicKey, secret, 'ctx')
  await assert.rejects(openFromSender(eve.privateKey, eve.publicKey, blob, 'ctx'), UnsealError)
  // Eve claiming to be Bob, with her own private key, fails too.
  await assert.rejects(openFromSender(eve.privateKey, bob.publicKey, blob, 'ctx'), UnsealError)
})

test('the context must match', async () => {
  const bob = await generateIdentityKeyPair()
  const blob = await sealForRecipient(bob.publicKey, secret, 'collection-key:c1')
  await assert.rejects(openFromSender(bob.privateKey, bob.publicKey, blob, 'collection-key:c2'), UnsealError)
})

test('an empty context is refused', async () => {
  const bob = await generateIdentityKeyPair()
  await assert.rejects(sealForRecipient(bob.publicKey, secret, ''))
})

test('every seal is different, even for the same input', async () => {
  const bob = await generateIdentityKeyPair()
  const a = await sealForRecipient(bob.publicKey, secret, 'ctx')
  const b = await sealForRecipient(bob.publicKey, secret, 'ctx')
  assert.notEqual(a, b)
  assert.notEqual(a.split('.')[1], b.split('.')[1], 'a fresh ephemeral key each time')
})

test('tampering with any part fails closed', async () => {
  const bob = await generateIdentityKeyPair()
  const blob = await sealForRecipient(bob.publicKey, secret, 'ctx')
  const other = await generateIdentityKeyPair()
  const parts = blob.split('.')
  const swappedEphemeral = [parts[0], toBase64Url(other.publicKey), ...parts.slice(2)].join('.')
  const flipped = blob.slice(0, -2) + (blob.endsWith('A') ? 'B' : 'A') + blob.slice(-1)
  for (const bad of [swappedEphemeral, flipped, 'pk1.x.y', 'v1.abc.def', blob.replace(/^pk1/, 'pk2'), '']) {
    await assert.rejects(openFromSender(bob.privateKey, bob.publicKey, bad, 'ctx'), UnsealError, bad.slice(0, 20))
  }
})

test('an invalid public key is refused before anything is sealed', async () => {
  const notOnCurve = new Uint8Array(PUBLIC_KEY_BYTES).fill(7)
  notOnCurve[0] = 0x04
  assert.equal(await isValidPublicKey(notOnCurve), false)
  assert.equal(await isValidPublicKey(new Uint8Array(33)), false)
  await assert.rejects(sealForRecipient(notOnCurve, secret, 'ctx'))
})

test('the private key is sealed under the vault key, bound to its purpose', async () => {
  const kp = await generateIdentityKeyPair()
  const vaultKey = generateVaultKey()
  const wrapped = await wrapIdentityPrivateKey(kp.privateKey, vaultKey)
  assert.deepEqual(await unwrapIdentityPrivateKey(wrapped, vaultKey), kp.privateKey)
  await assert.rejects(unwrapIdentityPrivateKey(wrapped, generateVaultKey()), UnsealError)
  assert.ok(!wrapped.includes(toBase64Url(kp.privateKey)))
})

test('fingerprints are stable, short, and differ between keys', async () => {
  const a = await generateIdentityKeyPair()
  const b = await generateIdentityKeyPair()
  const fa = await identityFingerprint(a.publicKey)
  assert.equal(fa, await identityFingerprint(a.publicKey))
  assert.match(fa, /^[0-9a-f]{4}( [0-9a-f]{4}){7}$/)
  assert.notEqual(fa, await identityFingerprint(b.publicKey))
})
