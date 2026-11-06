// Bulk import: many new items in one request, never an overwrite.

import test from 'node:test'
import assert from 'node:assert/strict'

import { harness, registration, sealedBlob } from './harness.js'

async function session() {
  const h = harness()
  const reg = await h.request('POST', '/api/auth/register', { body: registration() })
  return { h, token: String(reg.body['accessToken']) }
}

const id = (n: number) => `import-${String(n).padStart(8, '0')}`

test('a batch of entries and folders is created in one request', async () => {
  const { h, token } = await session()
  const res = await h.request('POST', '/api/vault/import', {
    token,
    body: {
      folders: [{ id: 'folder-00000001', blob: sealedBlob('f1') }],
      entries: Array.from({ length: 100 }, (_, i) => ({ id: id(i), blob: sealedBlob(`e${i}`) })),
    },
  })
  assert.equal(res.status, 201)
  const vault = await h.request('GET', '/api/vault', { token })
  assert.equal((vault.body['entries'] as unknown[]).length, 100)
  assert.equal((vault.body['folders'] as unknown[]).length, 1)
})

test('more than the per-request limit is refused', async () => {
  const { h, token } = await session()
  const res = await h.request('POST', '/api/vault/import', {
    token, body: { entries: Array.from({ length: 101 }, (_, i) => ({ id: id(i), blob: sealedBlob('x') })) },
  })
  assert.equal(res.status, 400)
})

test('import never overwrites an existing entry', async () => {
  const { h, token } = await session()
  await h.request('PUT', `/api/vault/entries/${id(1)}`, { token, body: { blob: sealedBlob('original') } })
  const res = await h.request('POST', '/api/vault/import', { token, body: { entries: [{ id: id(1), blob: sealedBlob('attacker') }] } })
  assert.equal(res.status, 409)
  const vault = await h.request('GET', '/api/vault', { token })
  assert.equal((vault.body['entries'] as Array<{ blob: string }>)[0]!.blob, sealedBlob('original'))
})

test('every item must be a sealed blob with a valid id', async () => {
  const { h, token } = await session()
  assert.equal((await h.request('POST', '/api/vault/import', { token, body: { entries: [{ id: 'bad id', blob: sealedBlob('x') }] } })).status, 400)
  assert.equal((await h.request('POST', '/api/vault/import', { token, body: { entries: [{ id: id(2), blob: 'plaintext password' }] } })).status, 400)
})

test('import needs a session', async () => {
  const h = harness()
  assert.equal((await h.request('POST', '/api/vault/import', { body: { entries: [] } })).status, 401)
})
