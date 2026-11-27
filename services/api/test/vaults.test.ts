// Several vaults per account: created with a wrapped key that never changes,
// named entries by an opaque id, emptied before deletion, and moved between
// with their history re-sealed. Another account cannot use them.

import test from 'node:test'
import assert from 'node:assert/strict'

import { harness, registration, sealedBlob } from './harness.js'

async function signedIn(h = harness(), email?: string) {
  const res = await h.request('POST', '/api/auth/register', { body: registration(email ? { email } : {}) })
  return { h, token: String(res.body['accessToken']) }
}

const WORK = 'vault-work-0001'
const E = 'entry-vaulted-1'

test('a vault is created, listed, renamed but never re-keyed, and capped', async () => {
  const { h, token } = await signedIn()
  assert.equal((await h.request('PUT', `/api/vault/vaults/${WORK}`, { token, body: { key: sealedBlob('k'), blob: sealedBlob('n1') } })).status, 201)
  assert.equal((await h.request('PUT', `/api/vault/vaults/${WORK}`, { token, body: { key: sealedBlob('k'), blob: sealedBlob('n2') } })).status, 200, 'rename')
  assert.equal((await h.request('PUT', `/api/vault/vaults/${WORK}`, { token, body: { key: sealedBlob('other'), blob: sealedBlob('n3') } })).status, 409, 'the key stays')
  assert.equal((await h.request('PUT', `/api/vault/vaults/${WORK}`, { token, body: { key: 'plain', blob: sealedBlob('n') } })).status, 400)
  const listed = await h.request('GET', '/api/vault', { token })
  assert.deepEqual((listed.body['vaults'] as { id: string; blob: string }[]).map((v) => [v.id, v.blob]), [[WORK, sealedBlob('n2')]])
  for (let i = 1; i < 20; i++) await h.request('PUT', `/api/vault/vaults/vault-cap-${String(i).padStart(4, '0')}`, { token, body: { key: sealedBlob(`k${i}`), blob: sealedBlob('n') } })
  assert.equal((await h.request('PUT', '/api/vault/vaults/vault-cap-9999', { token, body: { key: sealedBlob('k'), blob: sealedBlob('n') } })).status, 400, 'at most 20')
})

test('entries carry their vault id; an unknown or foreign vault is refused; a save without one is Personal', async () => {
  const { h, token } = await signedIn()
  const other = await signedIn(h, 'other@example.test')
  await h.request('PUT', `/api/vault/vaults/${WORK}`, { token, body: { key: sealedBlob('k'), blob: sealedBlob('n') } })
  assert.equal((await h.request('PUT', `/api/vault/entries/${E}`, { token, body: { blob: sealedBlob('e'), vaultId: WORK } })).status, 201)
  let list = (await h.request('GET', '/api/vault', { token })).body['entries'] as { id: string; vaultId?: string }[]
  assert.equal(list[0]!.vaultId, WORK)
  assert.equal((await h.request('PUT', '/api/vault/entries/entry-nowhere-1', { token, body: { blob: sealedBlob('e'), vaultId: 'vault-missing-1' } })).status, 400)
  assert.equal((await h.request('PUT', '/api/vault/entries/entry-theirs-1', { token: other.token, body: { blob: sealedBlob('e'), vaultId: WORK } })).status, 400, 'not their vault')
  await h.request('PUT', `/api/vault/entries/${E}`, { token, body: { blob: sealedBlob('e2') } })
  list = (await h.request('GET', '/api/vault', { token })).body['entries'] as { id: string; vaultId?: string }[]
  assert.equal(list[0]!.vaultId, undefined)
  assert.equal(((await h.request('GET', '/api/vault', { token: other.token })).body['vaults'] as unknown[]).length, 0)
})

test('a vault with items cannot be deleted; an empty one can', async () => {
  const { h, token } = await signedIn()
  await h.request('PUT', `/api/vault/vaults/${WORK}`, { token, body: { key: sealedBlob('k'), blob: sealedBlob('n') } })
  await h.request('PUT', `/api/vault/entries/${E}`, { token, body: { blob: sealedBlob('e'), vaultId: WORK } })
  assert.equal((await h.request('DELETE', `/api/vault/vaults/${WORK}`, { token })).status, 409)
  await h.request('DELETE', `/api/vault/entries/${E}`, { token })
  assert.equal((await h.request('DELETE', `/api/vault/vaults/${WORK}`, { token })).status, 200)
  assert.equal(((await h.request('GET', '/api/vault', { token })).body['vaults'] as unknown[]).length, 0)
})

test('moving an entry replaces it and every saved version, or nothing', async () => {
  const { h, token } = await signedIn()
  await h.request('PUT', `/api/vault/vaults/${WORK}`, { token, body: { key: sealedBlob('k'), blob: sealedBlob('n') } })
  await h.request('PUT', `/api/vault/entries/${E}`, { token, body: { blob: sealedBlob('personal') } })
  const added = await h.request('POST', `/api/vault/history/${E}`, { token, body: { blob: sealedBlob('old') } })
  const at = String(added.body['at'])

  const partial = await h.request('POST', `/api/vault/entries/${E}/move`, { token, body: { blob: sealedBlob('work'), vaultId: WORK, history: [] } })
  assert.equal(partial.status, 409, 'every version must come back re-sealed')

  const moved = await h.request('POST', `/api/vault/entries/${E}/move`, { token, body: { blob: sealedBlob('work'), vaultId: WORK, history: [{ at, blob: sealedBlob('old-work') }] } })
  assert.equal(moved.status, 200)
  const entry = ((await h.request('GET', '/api/vault', { token })).body['entries'] as { id: string; blob: string; vaultId?: string }[])[0]!
  assert.deepEqual([entry.id, entry.blob, entry.vaultId], [E, sealedBlob('work'), WORK])
  const versions = (await h.request('GET', `/api/vault/history/${E}`, { token })).body['versions'] as { blob: string }[]
  assert.deepEqual(versions.map((v) => v.blob), [sealedBlob('old-work')])

  const back = await h.request('POST', `/api/vault/entries/${E}/move`, { token, body: { blob: sealedBlob('home'), vaultId: null, history: [{ at, blob: sealedBlob('old-home') }] } })
  assert.equal(back.status, 200)
  const again = ((await h.request('GET', '/api/vault', { token })).body['entries'] as { vaultId?: string }[])[0]!
  assert.equal(again.vaultId, undefined, 'back in Personal')
  assert.equal((await h.request('POST', '/api/vault/entries/entry-missing-1/move', { token, body: { blob: sealedBlob('x') } })).status, 404)
})

test('bulk import can go into a vault', async () => {
  const { h, token } = await signedIn()
  await h.request('PUT', `/api/vault/vaults/${WORK}`, { token, body: { key: sealedBlob('k'), blob: sealedBlob('n') } })
  const res = await h.request('POST', '/api/vault/import', { token, body: { vaultId: WORK, entries: [{ id: 'entry-import-1', blob: sealedBlob('i') }], folders: [] } })
  assert.equal(res.status, 201)
  const list = (await h.request('GET', '/api/vault', { token })).body['entries'] as { vaultId?: string }[]
  assert.equal(list[0]!.vaultId, WORK)
})
