// Sharing: only the intended member opens a key; keys, names and items are
// bound to what they are for and cannot be presented as something else.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  UnsealError, generateCollectionKey, generateIdentityKeyPair, generateOrgKey,
  openCollectionKey, openCollectionMeta, openOrgKey, openSharedItem,
  sealCollectionKey, sealCollectionMeta, sealOrgKey, sealSharedItem,
} from '../src/index.js'

const item = { name: 'AWS root', type: 'login' as const, username: 'root', password: 'p', tags: [], customFields: [], favorite: false }

test('a collection key opens only for its member, its collection and its version', async () => {
  const alice = await generateIdentityKeyPair()
  const mallory = await generateIdentityKeyPair()
  const key = generateCollectionKey()
  const blob = await sealCollectionKey(alice.publicKey, key, 'coll-1', 1)
  assert.deepEqual(await openCollectionKey(alice.privateKey, alice.publicKey, blob, 'coll-1', 1), key)
  await assert.rejects(openCollectionKey(mallory.privateKey, mallory.publicKey, blob, 'coll-1', 1), UnsealError)
  await assert.rejects(openCollectionKey(alice.privateKey, alice.publicKey, blob, 'coll-2', 1), UnsealError, 'another collection')
  await assert.rejects(openCollectionKey(alice.privateKey, alice.publicKey, blob, 'coll-1', 2), UnsealError, 'another version')
})

test('the org key is bound to its organization', async () => {
  const alice = await generateIdentityKeyPair()
  const orgKey = generateOrgKey()
  const blob = await sealOrgKey(alice.publicKey, orgKey, 'org-1')
  assert.deepEqual(await openOrgKey(alice.privateKey, alice.publicKey, blob, 'org-1'), orgKey)
  await assert.rejects(openOrgKey(alice.privateKey, alice.publicKey, blob, 'org-2'), UnsealError)
})

test('an item cannot be moved to another collection, renamed to another id, or replayed at another version', async () => {
  const key = generateCollectionKey()
  const blob = await sealSharedItem('coll-1', 'item-1', 3, item, key)
  assert.deepEqual(await openSharedItem('coll-1', 'item-1', 3, blob, key), item)
  await assert.rejects(openSharedItem('coll-2', 'item-1', 3, blob, key), UnsealError)
  await assert.rejects(openSharedItem('coll-1', 'item-2', 3, blob, key), UnsealError)
  await assert.rejects(openSharedItem('coll-1', 'item-1', 4, blob, key), UnsealError)
  await assert.rejects(openSharedItem('coll-1', 'item-1', 3, blob, generateCollectionKey()), UnsealError, 'a rotated key does not open old ciphertext')
})

test('collection names are bound to their organization and collection', async () => {
  const orgKey = generateOrgKey()
  const blob = await sealCollectionMeta('org-1', 'coll-1', { name: 'Finance' }, orgKey)
  assert.equal((await openCollectionMeta('org-1', 'coll-1', blob, orgKey)).name, 'Finance')
  await assert.rejects(openCollectionMeta('org-1', 'coll-2', blob, orgKey), UnsealError)
  await assert.rejects(openCollectionMeta('org-2', 'coll-1', blob, orgKey), UnsealError)
})
