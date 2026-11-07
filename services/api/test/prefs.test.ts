// Preferences: sealed, per account, small, and gone with the account.

import test from 'node:test'
import assert from 'node:assert/strict'

import { fixtureB64, harness, registration, sealedBlob } from './harness.js'

async function twoPeople() {
  const h = harness({ adminEmails: ['owner@example.com'], allowRegistration: true })
  const owner = await h.request('POST', '/api/auth/register', { body: registration({ email: 'owner@example.com', authKey: fixtureB64('owner') }) })
  const a = await h.request('POST', '/api/auth/register', { body: registration({ email: 'a@example.com', authKey: fixtureB64('a') }) })
  const b = await h.request('POST', '/api/auth/register', { body: registration({ email: 'b@example.com', authKey: fixtureB64('b') }) })
  return {
    h, owner: String(owner.body['accessToken']),
    a: String(a.body['accessToken']), aId: String(a.body['userId']), b: String(b.body['accessToken']),
  }
}

test('preferences need a session', async () => {
  const h = harness()
  assert.equal((await h.request('GET', '/api/prefs')).status, 401)
  assert.equal((await h.request('PUT', '/api/prefs', { body: { blob: sealedBlob('p') } })).status, 401)
})

test('nothing stored yet reads as null; a stored blob reads back as sent', async () => {
  const { h, a } = await twoPeople()
  assert.equal((await h.request('GET', '/api/prefs', { token: a })).body['blob'], null)
  const put = await h.request('PUT', '/api/prefs', { token: a, body: { blob: sealedBlob('p1') } })
  assert.equal(put.status, 200)
  const got = await h.request('GET', '/api/prefs', { token: a })
  assert.equal(got.body['blob'], sealedBlob('p1'))
  assert.equal(got.body['updatedAt'], put.body['updatedAt'])
  await h.request('PUT', '/api/prefs', { token: a, body: { blob: sealedBlob('p2') } })
  assert.equal((await h.request('GET', '/api/prefs', { token: a })).body['blob'], sealedBlob('p2'))
})

test('each account sees only its own preferences', async () => {
  const { h, a, b } = await twoPeople()
  await h.request('PUT', '/api/prefs', { token: a, body: { blob: sealedBlob('mine') } })
  assert.equal((await h.request('GET', '/api/prefs', { token: b })).body['blob'], null)
})

test('only a sealed blob is accepted, and only a small one', async () => {
  const { h, a } = await twoPeople()
  assert.equal((await h.request('PUT', '/api/prefs', { token: a, body: { blob: '{"theme":"dark"}' } })).status, 400)
  assert.equal((await h.request('PUT', '/api/prefs', { token: a, body: {} })).status, 400)
  const big = sealedBlob('big').replace(/\.([^.]*)$/, (_m, tail: string) => '.' + tail + 'A'.repeat(9000))
  assert.equal((await h.request('PUT', '/api/prefs', { token: a, body: { blob: big } })).status, 413)
})

test('preferences do not show up as vault entries or folders', async () => {
  const { h, a } = await twoPeople()
  await h.request('PUT', '/api/prefs', { token: a, body: { blob: sealedBlob('p') } })
  const vault = await h.request('GET', '/api/vault', { token: a })
  assert.deepEqual(vault.body['entries'], [])
  assert.deepEqual(vault.body['folders'], [])
})

test('deleting the account deletes its preferences', async () => {
  const { h, owner, a, aId } = await twoPeople()
  await h.request('PUT', '/api/prefs', { token: a, body: { blob: sealedBlob('p') } })
  const del = await h.request('POST', `/api/admin/users/${aId}/delete`, { token: owner, body: { confirm: aId } })
  assert.equal(del.status, 200)
  assert.ok(!h.store.dump().some((i) => i.sk === 'PREFS'))
})
