// Guests (decisions/0032, 2d): an organization role that sees only the
// collections it is given, never the other members or groups, cannot ask for
// more, and may end on a date.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  generateCollectionKey, generateIdentityKeyPair, generateOrgKey, sealCollectionKey, sealCollectionMeta, sealOrgKey, sealOrgMeta, toBase64Url,
} from '@vault/crypto'

import { harness, registration, sealedBlob } from './harness.js'

type H = ReturnType<typeof harness>
const uuid = () => crypto.randomUUID()
const DAY = 86_400_000

async function person(h: H, email: string) {
  const keys = await generateIdentityKeyPair()
  const res = await h.request('POST', '/api/auth/register', { body: registration({ email, identity: { publicKey: toBase64Url(keys.publicKey), wrappedPrivateKey: sealedBlob(`${email}-pk`, 160) } }) })
  return { keys, token: String(res.body['accessToken']), refresh: String(res.body['refreshToken']), userId: String(res.body['userId']) }
}

async function setup() {
  const h = harness({ allowRegistration: true })
  const start = Date.UTC(2026, 10, 25, 12, 0, 0)
  h.setNow(start)
  const alice = await person(h, 'alice@example.test')
  const bob = await person(h, 'bob@example.test')
  const gus = await person(h, 'gus@example.test')
  const orgId = uuid(), orgKey = generateOrgKey()
  await h.request('POST', '/api/orgs', { token: alice.token, body: { id: orgId, hint: 'Acme', label: 'Alice', nameBlob: await sealOrgMeta(orgId, { name: 'Acme' }, orgKey), orgKeyBlob: await sealOrgKey(alice.keys.publicKey, orgKey, orgId) } })
  const colls: Record<string, { id: string; key: Uint8Array }> = {}
  for (const name of ['Finance', 'Ops']) {
    const id = uuid(), key = generateCollectionKey()
    await h.request('POST', `/api/orgs/${orgId}/collections`, { token: alice.token, body: { id, nameBlob: await sealCollectionMeta(orgId, id, { name }, orgKey), keyBlob: await sealCollectionKey(alice.keys.publicKey, key, id, 1) } })
    colls[name] = { id, key }
  }
  const join = async (p: typeof bob, email: string, extra: Record<string, unknown>) => {
    const inv = await h.request('POST', `/api/orgs/${orgId}/invites`, { token: alice.token, body: { email, label: email.split('@')[0], ...extra } })
    assert.equal(inv.status, 201)
    await h.request('POST', `/api/orgs/${orgId}/accept`, { token: p.token })
    await h.request('POST', `/api/orgs/${orgId}/members/${p.userId}/confirm`, { token: alice.token, body: { orgKeyBlob: await sealOrgKey(p.keys.publicKey, orgKey, orgId) } })
  }
  await join(bob, 'bob@example.test', {})
  await join(gus, 'gus@example.test', { role: 'guest', until: new Date(start + 7 * DAY).toISOString() })
  await h.request('PUT', `/api/orgs/${orgId}/collections/${colls['Finance']!.id}/access/${gus.userId}`, { token: alice.token, body: { set: 'use-only', keyBlob: await sealCollectionKey(gus.keys.publicKey, colls['Finance']!.key, colls['Finance']!.id, 1) } })
  return { h, start, alice, bob, gus, orgId, colls }
}

test('a guest sees only what they were given, not the other members or groups, and cannot ask for more', async () => {
  const { h, alice, gus, orgId, colls } = await setup()
  await h.request('POST', `/api/orgs/${orgId}/groups`, { token: alice.token, body: { id: uuid(), nameBlob: sealedBlob('g') } })

  const mine = (await h.request('GET', `/api/orgs/${orgId}/collections`, { token: gus.token })).body['collections'] as { id: string }[]
  assert.deepEqual(mine.map((c) => c.id), [colls['Finance']!.id])
  const people = (await h.request('GET', `/api/orgs/${orgId}/members`, { token: gus.token })).body['members'] as { label: string; role: string; until?: string }[]
  assert.deepEqual(people.map((m) => m.role).sort(), ['guest', 'owner'], 'the owner and themselves; not Bob')
  assert.equal(((await h.request('GET', `/api/orgs/${orgId}/groups`, { token: gus.token })).body['groups'] as unknown[]).length, 0)
  assert.equal((await h.request('POST', `/api/orgs/${orgId}/collections/${colls['Ops']!.id}/request`, { token: gus.token, body: { reason: 'please' } })).status, 403)

  // An admin sees the guest and the end date.
  const seen = (await h.request('GET', `/api/orgs/${orgId}/members`, { token: alice.token })).body['members'] as { role: string; until?: string }[]
  assert.ok(seen.find((m) => m.role === 'guest')!.until)
})

test("a guest's access ends on its date", async () => {
  const { h, start, alice, gus, orgId } = await setup()
  assert.equal((await h.request('GET', `/api/orgs/${orgId}/collections`, { token: gus.token })).status, 200)
  h.setNow(start + 8 * DAY)
  // A week on, both sessions need fresh access tokens.
  const fresh = async (p: { refresh: string }) => String((await h.request('POST', '/api/auth/refresh', { body: { refreshToken: p.refresh } })).body['accessToken'])
  gus.token = await fresh(gus)
  alice.token = await fresh(alice)
  const after = await h.request('GET', `/api/orgs/${orgId}/collections`, { token: gus.token })
  assert.equal(after.status, 403)
  assert.match(String(after.body['message']), /ended/)
  const org = ((await h.request('GET', '/api/orgs', { token: gus.token })).body['orgs'] as { ended?: boolean; orgKeyBlob?: string }[])[0]!
  assert.equal(org.ended, true)
  assert.equal(org.orgKeyBlob, undefined, 'no org key once it ended')
  const seen = (await h.request('GET', `/api/orgs/${orgId}/members`, { token: alice.token })).body['members'] as { role: string; ended?: boolean }[]
  assert.equal(seen.find((m) => m.role === 'guest')!.ended, true)
})

test('a guest end date must be in the future and within a year', async () => {
  const { h, start, alice, orgId } = await setup()
  const bad = async (until: number) => (await h.request('POST', `/api/orgs/${orgId}/invites`, { token: alice.token, body: { email: 'x@example.test', role: 'guest', until: new Date(until).toISOString() } })).status
  assert.equal(await bad(start - DAY), 400)
  assert.equal(await bad(start + 400 * DAY), 400)
  assert.equal(await bad(start + 30 * DAY), 201)
})
