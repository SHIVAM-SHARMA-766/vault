// Permission sets (decisions/0032, 2b): built-in and custom bundles of what a
// person may do in a collection. The server enforces the level; the apps keep
// reveal, fill and export, which arrive with each grant as its rights.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  generateCollectionKey, generateIdentityKeyPair, generateOrgKey, sealCollectionKey, sealCollectionMeta, sealOrgKey, sealOrgMeta, toBase64Url,
} from '@vault/crypto'

import { harness, registration, sealedBlob } from './harness.js'

type H = ReturnType<typeof harness>
const uuid = () => crypto.randomUUID()

async function person(h: H, email: string) {
  const keys = await generateIdentityKeyPair()
  const res = await h.request('POST', '/api/auth/register', { body: registration({ email, identity: { publicKey: toBase64Url(keys.publicKey), wrappedPrivateKey: sealedBlob(`${email}-pk`, 160) } }) })
  return { keys, token: String(res.body['accessToken']), userId: String(res.body['userId']) }
}

/** Alice's organization with a collection, and Bob confirmed in it. */
async function setup() {
  const h = harness({ allowRegistration: true })
  const alice = await person(h, 'alice@example.test')
  const bob = await person(h, 'bob@example.test')
  const orgId = uuid(), orgKey = generateOrgKey(), collId = uuid(), collKey = generateCollectionKey()
  await h.request('POST', '/api/orgs', { token: alice.token, body: { id: orgId, hint: 'Acme', label: 'Alice', nameBlob: await sealOrgMeta(orgId, { name: 'Acme' }, orgKey), orgKeyBlob: await sealOrgKey(alice.keys.publicKey, orgKey, orgId) } })
  await h.request('POST', `/api/orgs/${orgId}/collections`, { token: alice.token, body: { id: collId, nameBlob: await sealCollectionMeta(orgId, collId, { name: 'Finance' }, orgKey), keyBlob: await sealCollectionKey(alice.keys.publicKey, collKey, collId, 1) } })
  await h.request('POST', `/api/orgs/${orgId}/invites`, { token: alice.token, body: { email: 'bob@example.test', label: 'Bob' } })
  await h.request('POST', `/api/orgs/${orgId}/accept`, { token: bob.token })
  await h.request('POST', `/api/orgs/${orgId}/members/${bob.userId}/confirm`, { token: alice.token, body: { orgKeyBlob: await sealOrgKey(bob.keys.publicKey, orgKey, orgId) } })
  const keyBlob = await sealCollectionKey(bob.keys.publicKey, collKey, collId, 1)
  const grant = (body: Record<string, unknown>) => h.request('PUT', `/api/orgs/${orgId}/collections/${collId}/access/${bob.userId}`, { token: alice.token, body: { keyBlob, ...body } })
  const bobsRights = async () => ((await h.request('GET', `/api/orgs/${orgId}/collections`, { token: bob.token })).body['collections'] as { access: { permission: string; hidePasswords: boolean; rights: Record<string, unknown> } }[])[0]!.access
  return { h, alice, bob, orgId, collId, grant, bobsRights }
}

test('the built-in sets are listed and cannot be changed or removed', async () => {
  const { h, alice, bob, orgId } = await setup()
  const sets = (await h.request('GET', `/api/orgs/${orgId}/permission-sets`, { token: bob.token })).body['sets'] as { id: string; name: string }[]
  assert.deepEqual(sets.map((s) => s.name), ['Use only', 'Viewer', 'Editor', 'Manager'])
  assert.equal((await h.request('PUT', `/api/orgs/${orgId}/permission-sets/viewer`, { token: alice.token, body: { name: 'X', level: 'manage' } })).status, 400)
  assert.equal((await h.request('DELETE', `/api/orgs/${orgId}/permission-sets/editor`, { token: alice.token })).status, 400)
  assert.equal((await h.request('PUT', `/api/orgs/${orgId}/permission-sets/${uuid()}`, { token: bob.token, body: { name: 'Mine', level: 'manage' } })).status, 403, 'members cannot make sets')
})

test('a grant with a set takes its level and rights; older grants map to a built-in set', async () => {
  const { grant, bobsRights } = await setup()
  assert.equal((await grant({ set: 'use-only' })).status, 200)
  let a = await bobsRights()
  assert.deepEqual([a.permission, a.hidePasswords, a.rights], ['view', true, { set: 'use-only', reveal: false, fill: true, export: false }])
  await grant({ permission: 'edit', hidePasswords: false })
  a = await bobsRights()
  assert.deepEqual(a.rights, { set: 'editor', reveal: true, fill: true, export: true }, 'an older grant reads as Editor')
  assert.equal((await grant({ set: 'no-such-set' })).status, 400)
})

test('a custom set: made, given, changed (its grants follow), and kept while in use', async () => {
  const { h, alice, orgId, collId, bob, grant, bobsRights } = await setup()
  const id = uuid()
  const made = await h.request('PUT', `/api/orgs/${orgId}/permission-sets/${id}`, { token: alice.token, body: { name: 'Auditor', level: 'view', reveal: true, fill: false, export: true } })
  assert.equal(made.status, 200)
  assert.equal((await h.request('PUT', `/api/orgs/${orgId}/permission-sets/${uuid()}`, { token: alice.token, body: { name: 'auditor', level: 'view' } })).status, 409, 'names are unique')
  await grant({ set: id })
  assert.deepEqual((await bobsRights()).rights, { set: id, reveal: true, fill: false, export: true })

  // Changing the set changes what the grant allows.
  await h.request('PUT', `/api/orgs/${orgId}/permission-sets/${id}`, { token: alice.token, body: { name: 'Auditor', level: 'edit', reveal: false, fill: false, export: true } })
  const a = await bobsRights()
  assert.deepEqual([a.permission, a.hidePasswords], ['edit', true])
  const list = (await h.request('GET', `/api/orgs/${orgId}/collections/${collId}/access`, { token: alice.token })).body['access'] as { userId: string; set: string }[]
  assert.equal(list.find((x) => x.userId === bob.userId)!.set, id)

  // In use: kept. Once not in use: removed.
  assert.equal((await h.request('DELETE', `/api/orgs/${orgId}/permission-sets/${id}`, { token: alice.token })).status, 409)
  await grant({ set: 'viewer' })
  assert.equal((await h.request('DELETE', `/api/orgs/${orgId}/permission-sets/${id}`, { token: alice.token })).status, 200)
})
