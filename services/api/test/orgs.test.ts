// Organizations end to end, with the real cryptography: invite → accept →
// confirm by fingerprint → collection → grant → a member decrypts a shared
// item → removal cuts them off and marks the collection for rotation.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  fromBase64Url, generateCollectionKey, generateIdentityKeyPair, generateOrgKey, identityFingerprint,
  openCollectionKey, openOrgKey, openSharedItem, sealCollectionKey, sealOrgKey, sealOrgMeta, sealCollectionMeta,
  sealSharedItem, toBase64Url,
} from '@vault/crypto'

import { harness, registration, sealedBlob } from './harness.js'

type H = ReturnType<typeof harness>

async function person(h: H, email: string) {
  const keys = await generateIdentityKeyPair()
  const res = await h.request('POST', '/api/auth/register', {
    body: registration({ email, identity: { publicKey: toBase64Url(keys.publicKey), wrappedPrivateKey: sealedBlob(`${email}-pk`, 160) } }),
  })
  assert.equal(res.status, 201)
  return { email, keys, token: String(res.body['accessToken']), userId: String(res.body['userId']) }
}

const uuid = () => crypto.randomUUID()
const entry = { name: 'AWS root', type: 'login' as const, username: 'root', password: 'S3cret!', tags: [], customFields: [], favorite: false }

async function orgWithCollection(h: H) {
  const alice = await person(h, 'alice@example.test')
  const orgId = uuid()
  const orgKey = generateOrgKey()
  assert.equal((await h.request('POST', '/api/orgs', { token: alice.token, body: {
    id: orgId, hint: 'Acme', label: 'Alice', nameBlob: await sealOrgMeta(orgId, { name: 'Acme' }, orgKey), orgKeyBlob: await sealOrgKey(alice.keys.publicKey, orgKey, orgId),
  } })).status, 201)
  const collId = uuid()
  const collKey = generateCollectionKey()
  assert.equal((await h.request('POST', `/api/orgs/${orgId}/collections`, { token: alice.token, body: {
    id: collId, nameBlob: await sealCollectionMeta(orgId, collId, { name: 'Finance' }, orgKey), keyBlob: await sealCollectionKey(alice.keys.publicKey, collKey, collId, 1),
  } })).status, 201)
  return { alice, orgId, orgKey, collId, collKey }
}

test('invite → accept → confirm by fingerprint → share → the member decrypts', async () => {
  const h = harness()
  const { alice, orgId, orgKey, collId, collKey } = await orgWithCollection(h)
  const bob = await person(h, 'bob@example.test')

  // Alice invites Bob by address; Bob sees the invitation and accepts.
  assert.equal((await h.request('POST', `/api/orgs/${orgId}/invites`, { token: alice.token, body: { email: 'bob@example.test', label: 'Bob — finance' } })).status, 201)
  const invs = (await h.request('GET', '/api/orgs/invitations', { token: bob.token })).body['invitations'] as { orgId: string; hint: string }[]
  assert.deepEqual(invs.map((i) => [i.orgId, i.hint]), [[orgId, 'Acme']])
  assert.equal((await h.request('POST', `/api/orgs/${orgId}/accept`, { token: bob.token })).status, 200)

  // Accepted but unconfirmed: Bob gets no org key and no collections.
  const bobOrgs = (await h.request('GET', '/api/orgs', { token: bob.token })).body['orgs'] as { status: string; orgKeyBlob?: string }[]
  assert.equal(bobOrgs[0]!.status, 'accepted')
  assert.equal(bobOrgs[0]!.orgKeyBlob, undefined)
  assert.equal((await h.request('GET', `/api/orgs/${orgId}/collections`, { token: bob.token })).status, 403)

  // Alice sees Bob's fingerprint — the same one Bob sees for himself — and confirms.
  const list = (await h.request('GET', `/api/orgs/${orgId}/members`, { token: alice.token })).body['members'] as { userId: string; publicKey: string; status: string }[]
  const bobRow = list.find((m) => m.userId === bob.userId)!
  assert.equal(await identityFingerprint(fromBase64Url(bobRow.publicKey)), await identityFingerprint(bob.keys.publicKey))
  assert.equal((await h.request('POST', `/api/orgs/${orgId}/members/${bob.userId}/confirm`, { token: alice.token, body: {
    orgKeyBlob: await sealOrgKey(fromBase64Url(bobRow.publicKey), orgKey, orgId),
  } })).status, 200)

  // Alice grants Bob view access and adds an item.
  assert.equal((await h.request('PUT', `/api/orgs/${orgId}/collections/${collId}/access/${bob.userId}`, { token: alice.token, body: {
    permission: 'view', keyBlob: await sealCollectionKey(fromBase64Url(bobRow.publicKey), collKey, collId, 1),
  } })).status, 200)
  const itemId = uuid()
  assert.equal((await h.request('PUT', `/api/orgs/${orgId}/collections/${collId}/items/${itemId}`, { token: alice.token, body: {
    blob: await sealSharedItem(collId, itemId, 1, entry, collKey), keyVersion: 1,
  } })).status, 200)

  // Bob opens the org key, the collection key, and the item.
  const mine = ((await h.request('GET', '/api/orgs', { token: bob.token })).body['orgs'] as { orgKeyBlob: string }[])[0]!
  assert.deepEqual(await openOrgKey(bob.keys.privateKey, bob.keys.publicKey, mine.orgKeyBlob, orgId), orgKey)
  const colls = (await h.request('GET', `/api/orgs/${orgId}/collections`, { token: bob.token })).body['collections'] as { access: { keyBlob: string; permission: string } }[]
  const key = await openCollectionKey(bob.keys.privateKey, bob.keys.publicKey, colls[0]!.access.keyBlob, collId, 1)
  const items = (await h.request('GET', `/api/orgs/${orgId}/collections/${collId}/items`, { token: bob.token })).body['items'] as { id: string; blob: string }[]
  assert.deepEqual(await openSharedItem(collId, items[0]!.id, 1, items[0]!.blob, key), entry)

  // View means view: Bob cannot write or grant.
  assert.equal((await h.request('PUT', `/api/orgs/${orgId}/collections/${collId}/items/${uuid()}`, { token: bob.token, body: { blob: sealedBlob('x'), keyVersion: 1 } })).status, 403)
  assert.equal((await h.request('GET', `/api/orgs/${orgId}/collections/${collId}/access`, { token: bob.token })).status, 403)
})

test('removing a member cuts them off at once and marks their collections for rotation', async () => {
  const h = harness()
  const { alice, orgId, orgKey, collId, collKey } = await orgWithCollection(h)
  const bob = await person(h, 'bob@example.test')
  await h.request('POST', `/api/orgs/${orgId}/invites`, { token: alice.token, body: { email: bob.email } })
  await h.request('POST', `/api/orgs/${orgId}/accept`, { token: bob.token })
  await h.request('POST', `/api/orgs/${orgId}/members/${bob.userId}/confirm`, { token: alice.token, body: { orgKeyBlob: await sealOrgKey(bob.keys.publicKey, orgKey, orgId) } })
  await h.request('PUT', `/api/orgs/${orgId}/collections/${collId}/access/${bob.userId}`, { token: alice.token, body: { permission: 'edit', keyBlob: await sealCollectionKey(bob.keys.publicKey, collKey, collId, 1) } })

  const res = await h.request('DELETE', `/api/orgs/${orgId}/members/${bob.userId}`, { token: alice.token })
  assert.deepEqual(res.body['rotationNeeded'], [collId])
  assert.equal((await h.request('GET', `/api/orgs/${orgId}/collections/${collId}/items`, { token: bob.token })).status, 404)
  assert.equal(((await h.request('GET', '/api/orgs', { token: bob.token })).body['orgs'] as unknown[]).length, 0)
  const colls = (await h.request('GET', `/api/orgs/${orgId}/collections`, { token: alice.token })).body['collections'] as { rotationNeeded: boolean }[]
  assert.equal(colls[0]!.rotationNeeded, true)
})

test('invitations say nothing about whether an address has an account, and outsiders see nothing', async () => {
  const h = harness()
  const { alice, orgId, collId } = await orgWithCollection(h)
  const a = await h.request('POST', `/api/orgs/${orgId}/invites`, { token: alice.token, body: { email: 'nobody@example.test' } })
  const mallory = await person(h, 'mallory@example.test')
  const b = await h.request('POST', `/api/orgs/${orgId}/invites`, { token: alice.token, body: { email: 'mallory@example.test' } })
  assert.equal(a.status, b.status)
  assert.deepEqual(a.body, b.body)

  // Mallory has an invitation but has not accepted: still nothing.
  for (const path of [`/api/orgs/${orgId}/members`, `/api/orgs/${orgId}/collections`, `/api/orgs/${orgId}/collections/${collId}/items`]) {
    assert.equal((await h.request('GET', path, { token: mallory.token })).status, 404, path)
  }
  // A member cannot invite or confirm.
  const eve = await person(h, 'eve@example.test')
  assert.equal((await h.request('POST', `/api/orgs/${orgId}/invites`, { token: eve.token, body: { email: 'x@example.test' } })).status, 404)
})

test('only confirmed members can be given a key, and items are written under the current key version', async () => {
  const h = harness()
  const { alice, orgId, collId, collKey } = await orgWithCollection(h)
  const bob = await person(h, 'bob@example.test')
  await h.request('POST', `/api/orgs/${orgId}/invites`, { token: alice.token, body: { email: bob.email } })
  await h.request('POST', `/api/orgs/${orgId}/accept`, { token: bob.token })
  const grant = await h.request('PUT', `/api/orgs/${orgId}/collections/${collId}/access/${bob.userId}`, { token: alice.token, body: { permission: 'view', keyBlob: await sealCollectionKey(bob.keys.publicKey, collKey, collId, 1) } })
  assert.equal(grant.status, 409, 'unconfirmed')
  const stale = await h.request('PUT', `/api/orgs/${orgId}/collections/${collId}/items/${uuid()}`, { token: alice.token, body: { blob: sealedBlob('x'), keyVersion: 0 } })
  assert.equal(stale.status, 409)
  // A sealed-to-recipient key is required, not any string.
  const junk = await h.request('POST', `/api/orgs/${orgId}/members/${bob.userId}/confirm`, { token: alice.token, body: { orgKeyBlob: 'v1.abc.def' } })
  assert.equal(junk.status, 400)
})

test('rotation re-keys a collection: the removed member\'s old key opens nothing new, and stale requests are refused', async () => {
  const h = harness()
  const { alice, orgId, orgKey, collId, collKey } = await orgWithCollection(h)
  const bob = await person(h, 'bob@example.test')
  await h.request('POST', `/api/orgs/${orgId}/invites`, { token: alice.token, body: { email: bob.email } })
  await h.request('POST', `/api/orgs/${orgId}/accept`, { token: bob.token })
  await h.request('POST', `/api/orgs/${orgId}/members/${bob.userId}/confirm`, { token: alice.token, body: { orgKeyBlob: await sealOrgKey(bob.keys.publicKey, orgKey, orgId) } })
  await h.request('PUT', `/api/orgs/${orgId}/collections/${collId}/access/${bob.userId}`, { token: alice.token, body: { permission: 'view', keyBlob: await sealCollectionKey(bob.keys.publicKey, collKey, collId, 1) } })
  const itemId = uuid()
  await h.request('PUT', `/api/orgs/${orgId}/collections/${collId}/items/${itemId}`, { token: alice.token, body: { blob: await sealSharedItem(collId, itemId, 1, entry, collKey), keyVersion: 1 } })
  await h.request('DELETE', `/api/orgs/${orgId}/members/${bob.userId}`, { token: alice.token })

  const newKey = generateCollectionKey()
  const rotate = async (extra: Record<string, unknown> = {}) => h.request('POST', `/api/orgs/${orgId}/collections/${collId}/rotate`, { token: alice.token, body: {
    keyVersion: 2,
    grants: [{ userId: alice.userId, keyBlob: await sealCollectionKey(alice.keys.publicKey, newKey, collId, 2) }],
    items: [{ id: itemId, blob: await sealSharedItem(collId, itemId, 2, entry, newKey) }],
    ...extra,
  } })
  assert.equal((await rotate({ grants: [] })).status, 409, 'grants must match')
  assert.equal((await rotate({ items: [] })).status, 409, 'items must match')
  assert.equal((await rotate()).status, 200)
  assert.equal((await rotate()).status, 409, 'cannot rotate from a stale version')

  const colls = (await h.request('GET', `/api/orgs/${orgId}/collections`, { token: alice.token })).body['collections'] as { keyVersion: number; rotationNeeded: boolean; access: { keyBlob: string } }[]
  assert.equal(colls[0]!.keyVersion, 2)
  assert.equal(colls[0]!.rotationNeeded, false)
  const k2 = await openCollectionKey(alice.keys.privateKey, alice.keys.publicKey, colls[0]!.access.keyBlob, collId, 2)
  const items = (await h.request('GET', `/api/orgs/${orgId}/collections/${collId}/items`, { token: alice.token })).body['items'] as { id: string; blob: string; keyVersion: number }[]
  assert.equal(items[0]!.keyVersion, 2)
  assert.deepEqual(await openSharedItem(collId, itemId, 2, items[0]!.blob, k2), entry)
  // Bob's retired key opens nothing written now.
  await assert.rejects(openSharedItem(collId, itemId, 2, items[0]!.blob, collKey))
  // Writes at the old version are refused.
  assert.equal((await h.request('PUT', `/api/orgs/${orgId}/collections/${collId}/items/${uuid()}`, { token: alice.token, body: { blob: sealedBlob('x'), keyVersion: 1 } })).status, 409)
})

test('groups: granting a collection to a group gives each member a key; leaving the group revokes it and flags rotation', async () => {
  const h = harness()
  const { alice, orgId, orgKey, collId, collKey } = await orgWithCollection(h)
  const people = []
  for (const email of ['bob@example.test', 'cara@example.test']) {
    const p = await person(h, email)
    await h.request('POST', `/api/orgs/${orgId}/invites`, { token: alice.token, body: { email } })
    await h.request('POST', `/api/orgs/${orgId}/accept`, { token: p.token })
    await h.request('POST', `/api/orgs/${orgId}/members/${p.userId}/confirm`, { token: alice.token, body: { orgKeyBlob: await sealOrgKey(p.keys.publicKey, orgKey, orgId) } })
    people.push(p)
  }
  const [bob, cara] = people as [Awaited<ReturnType<typeof person>>, Awaited<ReturnType<typeof person>>]
  const groupId = uuid()
  assert.equal((await h.request('POST', `/api/orgs/${orgId}/groups`, { token: alice.token, body: { id: groupId, nameBlob: sealedBlob('g') } })).status, 201)
  await h.request('PUT', `/api/orgs/${orgId}/groups/${groupId}/members/${bob.userId}`, { token: alice.token })
  await h.request('PUT', `/api/orgs/${orgId}/groups/${groupId}/members/${cara.userId}`, { token: alice.token })

  // Missing a sealed key for a member: refused.
  const partial = await h.request('PUT', `/api/orgs/${orgId}/collections/${collId}/groups/${groupId}`, { token: alice.token, body: {
    permission: 'view', grants: [{ userId: bob.userId, keyBlob: await sealCollectionKey(bob.keys.publicKey, collKey, collId, 1) }],
  } })
  assert.equal(partial.status, 409)
  const ok = await h.request('PUT', `/api/orgs/${orgId}/collections/${collId}/groups/${groupId}`, { token: alice.token, body: {
    permission: 'view', grants: await Promise.all([bob, cara].map(async (p) => ({ userId: p.userId, keyBlob: await sealCollectionKey(p.keys.publicKey, collKey, collId, 1) }))),
  } })
  assert.equal(ok.body['granted'], 2)
  const cc = (await h.request('GET', `/api/orgs/${orgId}/collections`, { token: cara.token })).body['collections'] as { access: { keyBlob: string } }[]
  assert.deepEqual(await openCollectionKey(cara.keys.privateKey, cara.keys.publicKey, cc[0]!.access.keyBlob, collId, 1), collKey)

  // Cara leaves the group: her access goes and the collection needs a new key.
  const left = await h.request('DELETE', `/api/orgs/${orgId}/groups/${groupId}/members/${cara.userId}`, { token: alice.token })
  assert.deepEqual(left.body['rotationNeeded'], [collId])
  assert.equal((await h.request('GET', `/api/orgs/${orgId}/collections/${collId}/items`, { token: cara.token })).status, 404)
  assert.equal((await h.request('GET', `/api/orgs/${orgId}/collections/${collId}/items`, { token: bob.token })).status, 200)
  const gs = (await h.request('GET', `/api/orgs/${orgId}/groups`, { token: alice.token })).body['groups'] as { members: string[]; collections: unknown[] }[]
  assert.deepEqual(gs[0]!.members, [bob.userId])
  assert.equal(gs[0]!.collections.length, 1)
})
