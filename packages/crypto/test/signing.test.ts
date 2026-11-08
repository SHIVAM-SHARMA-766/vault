// Signing keys and signed key grants (decisions/0025): known answers first,
// then the refusals that close threat A15.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  type Grant, endorsementBytes, fromBase64Url, fullFingerprint, generateSigningKeyPair, generateIdentityKeyPair, grantBytes,
  signBytes, signGrant, unwrapSigningPrivateKey, verifyBytes, verifyGrant, wrapSigningPrivateKey, UnsealError,
} from '../src/index.js'

const G: Grant = { orgId: 'org-1', collectionId: 'coll-1', version: 2, recipient: 'aaaa bbbb cccc dddd eeee ffff 0000 1111', keyBlob: 'pk1.AAA.v1.BBB.CCC' }
// A fixed public key and a signature it made over G (ECDSA is randomized, so
// the known answer is a verification). Checked once against Node's crypto.
const PUB = fromBase64Url('BIBZJ20l2wTicqsx_WYMZPsW-AcQ-OGUfC2tui4XOO7T45ij_EeV1-fQKl9eKdl8FCrHqVWcxDJroJz9iZMKGNI')
const SIG = '8ibhhG2URhNC9i30dTJdfJ0tmvFUaQD-5zudD-LAnHShLHHl20PPaIRqODqnzpUzf5uG-1fa2Ri96ICVF5Hn1g'

test('known answers: the signed bytes, the fingerprint, and a fixed signature', async () => {
  assert.equal(new TextDecoder().decode(await grantBytes(G)), 'vault.grant.v1|org-1|coll-1|2|aaaabbbbccccddddeeeeffff00001111|iGTqSi3rOp2jt8zLvaYgsPyyPS47z2pMbKXMZ5nRy24')
  assert.equal(await fullFingerprint(new Uint8Array(65).fill(4), new Uint8Array(65).fill(5)), '1342 3b55 9c55 a28c 15ec 8dc7 95c7 d8e7')
  assert.equal(await verifyGrant(PUB, G, SIG), true)
  assert.equal(new TextDecoder().decode(endorsementBytes('org-1', 'aaaa bbbb')), 'vault.admin.v1|org-1|aaaabbbb')
})

test('a changed version, recipient, key blob, collection or organization fails', async () => {
  for (const changed of [{ version: 3 }, { recipient: 'aaaa bbbb cccc dddd eeee ffff 0000 2222' }, { keyBlob: 'pk1.AAA.v1.BBB.CCD' }, { collectionId: 'coll-2' }, { orgId: 'org-2' }]) {
    assert.equal(await verifyGrant(PUB, { ...G, ...changed }, SIG), false, JSON.stringify(changed))
  }
})

test('a signature by another key, or junk, fails; signing and verifying round-trip', async () => {
  const other = await generateSigningKeyPair()
  assert.equal(await verifyGrant(other.publicKey, G, SIG), false)
  const mine = await generateSigningKeyPair()
  const sig = await signGrant(mine.privateKey, G)
  assert.equal(await verifyGrant(mine.publicKey, G, sig), true)
  assert.equal(await verifyGrant(mine.publicKey, G, 'not-a-signature'), false)
  assert.equal(await verifyBytes(new Uint8Array(65), new Uint8Array(1), sig), false, 'an invalid point is a failure, not a crash')
  const e = await signBytes(mine.privateKey, endorsementBytes('org-1', 'ff ff'))
  assert.equal(await verifyBytes(mine.publicKey, endorsementBytes('org-1', 'ffff'), e), true, 'spaces do not matter')
})

test('the signing private key is sealed under the vault key and only that key', async () => {
  const pair = await generateSigningKeyPair()
  const vaultKey = new Uint8Array(32).fill(3)
  const wrapped = await wrapSigningPrivateKey(pair.privateKey, vaultKey)
  assert.deepEqual(await unwrapSigningPrivateKey(wrapped, vaultKey), pair.privateKey)
  await assert.rejects(unwrapSigningPrivateKey(wrapped, new Uint8Array(32).fill(4)), UnsealError)
  // A fingerprint covers both keys, so swapping either changes it.
  const ecdh = await generateIdentityKeyPair()
  assert.notEqual(await fullFingerprint(ecdh.publicKey, pair.publicKey), await fullFingerprint(ecdh.publicKey, (await generateSigningKeyPair()).publicKey))
})
