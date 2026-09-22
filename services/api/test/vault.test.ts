// The vault routes. Everything here is ciphertext the server cannot read, so
// what is tested is shape, ownership, and lifecycle.

import test from 'node:test'
import assert from 'node:assert/strict'

import { harness, registration, sealedBlob } from './harness.js'

async function signedIn() {
  const h = harness()
  const res = await h.request('POST', '/api/auth/register', { body: registration() })
  return { h, token: String(res.body['accessToken']) }
}

const ENTRY = 'entry-aaaaaaaa'

test('an entry can be written, listed, and replaced', async () => {
  const { h, token } = await signedIn()

  const created = await h.request('PUT', `/api/vault/entries/${ENTRY}`, {
    token, body: { blob: sealedBlob("b1") },
  })
  assert.equal(created.status, 201)

  const listed = await h.request('GET', '/api/vault', { token })
  const entries = listed.body['entries'] as { id: string; blob: string }[]
  assert.equal(entries.length, 1)
  assert.equal(entries[0]!.blob, sealedBlob("b1"))

  const replaced = await h.request('PUT', `/api/vault/entries/${ENTRY}`, {
    token, body: { blob: sealedBlob("b2") },
  })
  assert.equal(replaced.status, 200, 'an update, not a create')
  assert.equal(replaced.body['createdAt'], created.body['createdAt'], 'creation time is preserved')
})

test('the server stores the blob and nothing derived from it', async () => {
  const { h, token } = await signedIn()
  await h.request('PUT', `/api/vault/entries/${ENTRY}`, { token, body: { blob: sealedBlob("b1") } })

  const stored = h.store.dump().find((i) => i.sk.startsWith('ENTRY#'))
  assert.ok(stored)
  assert.deepEqual(Object.keys(stored).sort(), ['blob', 'createdAt', 'id', 'pk', 'sk', 'updatedAt'])
})

test('an unsealed or oversized blob is refused', async () => {
  const { h, token } = await signedIn()

  const unsealed = await h.request('PUT', `/api/vault/entries/${ENTRY}`, {
    token, body: { blob: 'plaintext' },
  })
  assert.equal(unsealed.status, 400)

  const huge = await h.request('PUT', `/api/vault/entries/${ENTRY}`, {
    token, body: { blob: sealedBlob("big", 400 * 1024) },
  })
  assert.equal(huge.status, 413, 'rejected before DynamoDB would reject the item')
})

test('an identifier that could address another item type is refused', async () => {
  // Identifiers become part of the sort key, so one containing '#' could
  // otherwise reach a PROFILE or SESSION item.
  const { h, token } = await signedIn()
  for (const id of ['../PROFILE', 'x#PROFILE', 'short', 'a'.repeat(100)]) {
    const res = await h.request('PUT', `/api/vault/entries/${encodeURIComponent(id)}`, {
      token, body: { blob: sealedBlob("b1") },
    })
    assert.equal(res.status, 400, `rejected: ${id}`)
  }
})

test('deleting an entry takes its history with it', async () => {
  const { h, token } = await signedIn()
  await h.request('PUT', `/api/vault/entries/${ENTRY}`, { token, body: { blob: sealedBlob("b1") } })
  await h.request('POST', `/api/vault/history/${ENTRY}`, { token, body: { blob: sealedBlob("b2") } })

  assert.equal(
    ((await h.request('GET', `/api/vault/history/${ENTRY}`, { token })).body['versions'] as unknown[]).length,
    1,
  )

  await h.request('DELETE', `/api/vault/entries/${ENTRY}`, { token })
  assert.equal(h.store.dump().filter((i) => i.sk.startsWith('HIST#')).length, 0)
})

test('history is capped, oldest first', async () => {
  const { h, token } = await signedIn()
  await h.request('PUT', `/api/vault/entries/${ENTRY}`, { token, body: { blob: sealedBlob("b0") } })

  const base = Date.UTC(2026, 8, 22, 12, 0, 0)
  for (let i = 0; i < 25; i++) {
    h.setNow(base + i * 1000)
    await h.request('POST', `/api/vault/history/${ENTRY}`, { token, body: { blob: sealedBlob(`v${i}`) } })
  }

  const versions = (await h.request('GET', `/api/vault/history/${ENTRY}`, { token }))
    .body['versions'] as { at: string }[]
  assert.equal(versions.length, 20)
  // Newest first, and the five oldest are gone.
  assert.equal(versions[0]!.at, new Date(base + 24 * 1000).toISOString())
})

test('history for an entry that does not exist is refused', async () => {
  const { h, token } = await signedIn()
  const res = await h.request('POST', `/api/vault/history/${ENTRY}`, {
    token, body: { blob: sealedBlob("b1") },
  })
  assert.equal(res.status, 404)
})

test('deleting a folder leaves its entries alone', async () => {
  // Folder membership lives inside each entry's ciphertext, so the server
  // cannot reassign it. See vault/decisions/0002.
  const { h, token } = await signedIn()
  await h.request('PUT', '/api/vault/folders/folder-aaaa', { token, body: { blob: sealedBlob("b1") } })
  await h.request('PUT', `/api/vault/entries/${ENTRY}`, { token, body: { blob: sealedBlob("b2") } })

  await h.request('DELETE', '/api/vault/folders/folder-aaaa', { token })

  const after = await h.request('GET', '/api/vault', { token })
  assert.equal((after.body['entries'] as unknown[]).length, 1)
  assert.equal((after.body['folders'] as unknown[]).length, 0)
})

test('every vault route needs authentication', async () => {
  const { h } = await signedIn()
  const calls: [string, string][] = [
    ['GET', '/api/vault'],
    ['PUT', `/api/vault/entries/${ENTRY}`],
    ['DELETE', `/api/vault/entries/${ENTRY}`],
    ['PUT', '/api/vault/folders/folder-aaaa'],
    ['GET', `/api/vault/history/${ENTRY}`],
    ['GET', '/api/activity'],
    ['GET', '/api/auth/me'],
  ]
  for (const [method, path] of calls) {
    const res = await h.request(method, path, { body: { blob: sealedBlob("b1") } })
    assert.equal(res.status, 401, `${method} ${path}`)
  }
})

test('an unknown path is a 404', async () => {
  const { h, token } = await signedIn()
  assert.equal((await h.request('GET', '/api/nope', { token })).status, 404)
  assert.equal((await h.request('POST', '/api/vault', { token })).status, 404)
})

test('responses are never cacheable', async () => {
  // CloudFront disables caching on /api/*, but the function must also say so
  // in case it is ever reached another way.
  const { h, token } = await signedIn()
  const res = await h.request('GET', '/api/vault', { token })
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
})
