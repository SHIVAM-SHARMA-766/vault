// Share links (D3): the server stores ciphertext with an expiry and a view
// limit, counts every open, and forgets the copy when it is used up, expired,
// revoked, or its owner's account is deleted.

import test from 'node:test'
import assert from 'node:assert/strict'

import { fixtureB64, harness, registration, sealedBlob } from './harness.js'

const HOUR = 3600
const DAY = 86_400

async function setup() {
  const h = harness({ allowRegistration: true })
  const me = (await h.request('POST', '/api/auth/register', { body: registration() })).body
  return { h, token: String(me['accessToken']) }
}

let n = 0
const newId = () => fixtureB64(`share-${++n}`, 16).replace(/=+$/, '')

const create = (h: ReturnType<typeof harness>, token: string, extra: Record<string, unknown> = {}) => {
  const id = newId()
  return h.request('POST', '/api/shares', {
    token, body: { id, blob: sealedBlob(`s${n}`), labelBlob: sealedBlob(`l${n}`), expiresIn: DAY, maxViews: 1, ...extra },
  }).then((res) => ({ res, id: (extra['id'] as string | undefined) ?? id }))
}

const open = (h: ReturnType<typeof harness>, id: string, ip = '198.51.100.20') => h.request('POST', `/api/shares/${id}/open`, { ip })

test('a one-view link opens once, without an account, then is gone', async () => {
  const { h, token } = await setup()
  const { res, id } = await create(h, token)
  assert.equal(res.status, 201)
  const first = await open(h, id)
  assert.equal(first.status, 200)
  assert.match(String(first.body['blob']), /^v1\./)
  assert.equal(first.body['viewsLeft'], 0)
  const second = await open(h, id)
  assert.equal(second.status, 404)
  assert.match(String(second.body['message']), /expired, was used up, or was revoked/)
  assert.ok(!h.store.dump().some((r) => r.pk === `SHARE#${id}` && r.sk === 'META'), 'the copy is deleted')
})

test('a link with no view limit opens until it expires', async () => {
  const { h, token } = await setup()
  const { id } = await create(h, token, { maxViews: null, expiresIn: HOUR })
  for (let i = 0; i < 4; i++) {
    const r = await open(h, id)
    assert.equal(r.status, 200)
    assert.equal(r.body['viewsLeft'], null)
  }
  h.setNow(h.app.now() + HOUR * 1000 + 1)
  assert.equal((await open(h, id)).status, 404)
})

test('views left counts down, and the owner sees the count and status', async () => {
  const { h, token } = await setup()
  const { id } = await create(h, token, { maxViews: 2 })
  assert.equal((await open(h, id)).body['viewsLeft'], 1)
  let list = (await h.request('GET', '/api/shares', { token })).body['shares'] as { id: string; views: number; status: string; maxViews: number }[]
  assert.deepEqual(list.map((s) => [s.id, s.views, s.status, s.maxViews]), [[id, 1, 'live', 2]])
  await open(h, id)
  list = (await h.request('GET', '/api/shares', { token })).body['shares'] as typeof list
  assert.equal(list[0]!.status, 'used')
})

test('opening is recorded in the owner\'s activity, with where it came from', async () => {
  const { h, token } = await setup()
  const { id } = await create(h, token)
  await open(h, id, '192.0.2.44')
  const events = (await h.request('GET', '/api/activity', { token })).body['events'] as { kind: string; ip: string }[]
  assert.ok(events.some((e) => e.kind === 'share-create'))
  assert.equal(events.find((e) => e.kind === 'share-open')!.ip, '192.0.2.44')
})

test('the owner can revoke a link; nobody else can', async () => {
  const { h, token } = await setup()
  const { id } = await create(h, token, { maxViews: 5 })
  const stranger = String((await h.request('POST', '/api/auth/register', { body: registration({ email: 'other@example.test', authKey: fixtureB64('other') }) })).body['accessToken'])
  assert.equal((await h.request('DELETE', `/api/shares/${id}`, { token: stranger })).status, 404)
  assert.equal((await open(h, id)).status, 200)
  assert.equal((await h.request('DELETE', `/api/shares/${id}`, { token })).status, 200)
  assert.equal((await open(h, id)).status, 404)
  const list = (await h.request('GET', '/api/shares', { token })).body['shares'] as { status: string }[]
  assert.equal(list[0]!.status, 'revoked')
})

test('expiry and view limits must be offered choices; blobs must be sealed and small; ids unique', async () => {
  const { h, token } = await setup()
  for (const bad of [{ expiresIn: 60 }, { expiresIn: '3600' }, { maxViews: 3 }, { maxViews: 0 }, { blob: 'plain text' }, { id: 'short' }, { blob: sealedBlob('big', 70 * 1024) }]) {
    assert.ok([400, 413].includes((await create(h, token, bad)).res.status), JSON.stringify(Object.keys(bad)))
  }
  const { id } = await create(h, token)
  assert.equal((await create(h, token, { id })).res.status, 409)
  assert.equal((await h.request('POST', '/api/shares', { body: { id: newId() } })).status, 401, 'creating needs an account')
})

test('a malformed or unknown id is the same 404 as a used one', async () => {
  const { h } = await setup()
  for (const id of ['nope', newId(), '../../etc']) assert.equal((await open(h, encodeURIComponent(id))).status, 404)
})

test('opening is rate limited per address', async () => {
  const { h } = await setup()
  let last = 0
  for (let i = 0; i < 32; i++) last = (await open(h, newId(), '203.0.113.99')).status
  assert.equal(last, 429)
})

test('deleting the account deletes every live copy', async () => {
  const { h, token } = await setup()
  const { id } = await create(h, token, { maxViews: null })
  assert.equal((await h.request('POST', '/api/account/delete', { token, body: { currentAuthKey: fixtureB64('auth-key'), confirm: 'DELETE' } })).status, 200)
  assert.equal((await open(h, id)).status, 404)
  assert.ok(!h.store.dump().some((r) => r.pk.startsWith('SHARE#')))
})

test('the server never holds the key: nothing stored looks like a link fragment', async () => {
  const { h, token } = await setup()
  const { id } = await create(h, token)
  const row = h.store.dump().find((r) => r.pk === `SHARE#${id}` && r.sk === 'META')!
  assert.deepEqual(Object.keys(row).sort(), ['blob', 'createdAt', 'expiresAt', 'maxViews', 'ownerId', 'pk', 'sk'])
})
