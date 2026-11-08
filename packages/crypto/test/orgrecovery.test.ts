// The organization recovery key (decisions/0026).

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  UnsealError, createOrgRecovery, deriveOrgRecovery, fromBase64Url, generateCollectionKey, generateOrgKey,
  openCollectionKeyFromRecovery, openOrgKeyFromRecovery, openOrgRecoveryEscrow, recoveryVerifier,
  sealCollectionKeyForRecovery, sealOrgKeyForRecovery, toHex,
} from '../src/index.js'

test('the kek and the auth key are independent branches, bound to the organization', async () => {
  const r = new Uint8Array(32).fill(7)
  const a = await deriveOrgRecovery(r, 'org-a')
  const b = await deriveOrgRecovery(r, 'org-b')
  assert.notEqual(toHex(a.kek), toHex(a.auth))
  assert.notEqual(toHex(a.kek), toHex(b.kek), 'another organization, another key')
  // Known answers: HKDF-SHA256(ikm = 0x07 × 32, salt = 0 × 32, info), checked
  // against Node's own hkdfSync. A change here breaks every recovery key issued.
  assert.equal(toHex(a.kek), '3093e7d98b99851f5af0496b943ab4f5fc771093d8537d8484a2116417b65218')
  assert.equal(toHex(a.auth), 'fed307176fdedb178cf86d5c6377f22efa826815f941fa2c86babb0460c95df9')
  assert.equal(await recoveryVerifier(a.auth), await recoveryVerifier((await deriveOrgRecovery(r, 'org-a')).auth))
  await assert.rejects(deriveOrgRecovery(new Uint8Array(16), 'org-a'), /32 bytes/)
})

test('the recovery key opens the escrow, which opens the org key and every collection key', async () => {
  const rec = await createOrgRecovery('org-1')
  const { kek, auth } = await deriveOrgRecovery(rec.recoveryKey, 'org-1')
  assert.equal(await recoveryVerifier(auth), rec.verifier)
  const priv = await openOrgRecoveryEscrow(kek, rec.escrow, 'org-1')
  const pub = fromBase64Url(rec.publicKey)
  const orgKey = generateOrgKey()
  const collKey = generateCollectionKey()
  const orgBlob = await sealOrgKeyForRecovery(pub, orgKey, 'org-1')
  const collBlob = await sealCollectionKeyForRecovery(pub, collKey, 'coll-1', 3)
  assert.deepEqual(await openOrgKeyFromRecovery(priv, pub, orgBlob, 'org-1'), orgKey)
  assert.deepEqual(await openCollectionKeyFromRecovery(priv, pub, collBlob, 'coll-1', 3), collKey)
})

test('the wrong recovery key, organization, collection or version opens nothing', async () => {
  const rec = await createOrgRecovery('org-1')
  const wrong = await deriveOrgRecovery(new Uint8Array(32).fill(1), 'org-1')
  await assert.rejects(openOrgRecoveryEscrow(wrong.kek, rec.escrow, 'org-1'), UnsealError)
  const { kek } = await deriveOrgRecovery(rec.recoveryKey, 'org-1')
  await assert.rejects(openOrgRecoveryEscrow(kek, rec.escrow, 'org-2'), UnsealError, 'escrow bound to its org')
  const priv = await openOrgRecoveryEscrow(kek, rec.escrow, 'org-1')
  const pub = fromBase64Url(rec.publicKey)
  const blob = await sealCollectionKeyForRecovery(pub, generateCollectionKey(), 'coll-1', 1)
  await assert.rejects(openCollectionKeyFromRecovery(priv, pub, blob, 'coll-2', 1), UnsealError)
  await assert.rejects(openCollectionKeyFromRecovery(priv, pub, blob, 'coll-1', 2), UnsealError)
})
