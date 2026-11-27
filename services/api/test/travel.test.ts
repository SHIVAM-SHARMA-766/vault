// Travel mode: vaults not marked safe are not served and cannot be touched;
// turning it on is free, bringing anything back needs the master password.

import test from 'node:test'
import assert from 'node:assert/strict'

import { fixtureB64, harness, registration, sealedBlob } from './harness.js'

const EMAIL = 'traveller@example.com'
const WORK = 'vault-work-0001'
const HOME = 'vault-home-0001'

async function setup() {
  const h = harness()
  const token = String((await h.request('POST', '/api/auth/register', { body: registration({ email: EMAIL, authKey: fixtureB64(EMAIL) }) })).body['accessToken'])
  for (const v of [WORK, HOME]) await h.request('PUT', `/api/vault/vaults/${v}`, { token, body: { key: sealedBlob(`k${v}`), blob: sealedBlob('n') } })
  await h.request('PUT', '/api/vault/entries/entry-personal-1', { token, body: { blob: sealedBlob('p') } })
  await h.request('PUT', '/api/vault/entries/entry-work-0001', { token, body: { blob: sealedBlob('w'), vaultId: WORK } })
  await h.request('PUT', '/api/vault/entries/entry-home-0001', { token, body: { blob: sealedBlob('h'), vaultId: HOME } })
  await h.request('POST', '/api/vault/history/entry-work-0001', { token, body: { blob: sealedBlob('old') } })
  return { h, token }
}
const ids = async (h: ReturnType<typeof harness>, token: string) => {
  const v = (await h.request('GET', '/api/vault', { token })).body
  return { entries: (v['entries'] as { id: string }[]).map((e) => e.id).sort(), vaults: (v['vaults'] as { id: string }[]).map((x) => x.id).sort(), travel: v['travel'] as { on: boolean } }
}

test('on: only safe vaults are served; the others cannot be read, written, moved or deleted', async () => {
  const { h, token } = await setup()
  assert.equal((await h.request('PUT', '/api/vault/travel', { token, body: { safe: ['personal', HOME] } })).status, 200)
  assert.deepEqual((await ids(h, token)).entries.length, 3, 'nothing hidden while off')
  const on = await h.request('PUT', '/api/vault/travel', { token, body: { on: true } })
  assert.deepEqual(on.body, { on: true, safe: ['personal', HOME].sort() })

  const now = await ids(h, token)
  assert.deepEqual(now.entries, ['entry-home-0001', 'entry-personal-1'])
  assert.deepEqual(now.vaults, [HOME])
  assert.equal(now.travel.on, true)

  assert.deepEqual((await h.request('GET', '/api/vault/history/entry-work-0001', { token })).body['versions'], [])
  assert.equal((await h.request('PUT', '/api/vault/entries/entry-work-0001', { token, body: { blob: sealedBlob('x'), vaultId: WORK } })).status, 400)
  assert.equal((await h.request('PUT', '/api/vault/entries/entry-work-0001', { token, body: { blob: sealedBlob('x') } })).status, 404, 'not overwritable as Personal either')
  assert.equal((await h.request('DELETE', '/api/vault/entries/entry-work-0001', { token })).status, 404)
  assert.equal((await h.request('POST', '/api/vault/history/entry-work-0001', { token, body: { blob: sealedBlob('y') } })).status, 404)
  assert.equal((await h.request('POST', '/api/vault/entries/entry-home-0001/move', { token, body: { blob: sealedBlob('m'), vaultId: WORK, history: [] } })).status, 400, 'nothing moves into a hidden vault')
  assert.equal((await h.request('DELETE', `/api/vault/vaults/${WORK}`, { token })).status, 404)
  assert.equal((await h.request('PUT', `/api/vault/vaults/${WORK}`, { token, body: { key: sealedBlob(`k${WORK}`), blob: sealedBlob('n2') } })).status, 404)
})

test('off, or another vault marked safe while on, needs the master password again', async () => {
  const { h, token } = await setup()
  await h.request('PUT', '/api/vault/travel', { token, body: { on: true, safe: ['personal'] } })
  h.setNow(h.app.now() + 11 * 60_000)
  // Hiding more is free.
  assert.equal((await h.request('PUT', '/api/vault/travel', { token, body: { safe: [] } })).status, 200)
  assert.deepEqual((await ids(h, token)).entries, [], 'Personal hidden too now')
  for (const body of [{ on: false }, { safe: [WORK] }]) {
    const r = await h.request('PUT', '/api/vault/travel', { token, body })
    assert.equal(r.status, 403)
    assert.equal(r.body['error'], 'reauth_required')
  }
  await h.request('POST', '/api/auth/reauth', { token, body: { authKey: fixtureB64(EMAIL) } })
  assert.equal((await h.request('PUT', '/api/vault/travel', { token, body: { on: false } })).status, 200)
  assert.equal((await ids(h, token)).entries.length, 3, 'everything is back')
  assert.equal((await h.request('PUT', '/api/vault/travel', { token, body: { safe: ['vault-not-mine-1'] } })).status, 400)
})
