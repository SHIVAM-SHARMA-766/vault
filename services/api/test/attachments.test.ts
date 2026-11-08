// Attachments (D2): ciphertext stored per account, never replaced, within a
// quota, private to its owner, and carried in personal backups.

import test from 'node:test'
import assert from 'node:assert/strict'

import { ATTACHMENT_QUOTA_BYTES } from '../src/routes/attachments.js'
import { buildFile } from '../src/personal-backup.js'
import { fixtureB64, harness, registration, sealedBlob } from './harness.js'

async function two() {
  const h = harness({ allowRegistration: true })
  const a = (await h.request('POST', '/api/auth/register', { body: registration() })).body
  const b = (await h.request('POST', '/api/auth/register', { body: registration({ email: 'b@example.test', authKey: fixtureB64('b') }) })).body
  return { h, a: String(a['accessToken']), aId: String(a['userId']), b: String(b['accessToken']) }
}

test('store, fetch and delete an encrypted attachment; usage follows', async () => {
  const { h, a } = await two()
  const id = crypto.randomUUID()
  const blob = sealedBlob('file', 4096)
  const put = await h.request('PUT', `/api/attachments/${id}`, { token: a, body: { blob } })
  assert.equal(put.status, 201)
  assert.equal((await h.request('GET', `/api/attachments/${id}`, { token: a })).body['blob'], blob)
  assert.equal((await h.request('GET', '/api/attachments', { token: a })).body['count'], 1)
  assert.equal((await h.request('PUT', `/api/attachments/${id}`, { token: a, body: { blob: sealedBlob('other') } })).status, 409, 'never replaced')
  assert.equal((await h.request('DELETE', `/api/attachments/${id}`, { token: a })).status, 200)
  assert.equal((await h.request('GET', `/api/attachments/${id}`, { token: a })).status, 404)
})

test('another account cannot read or delete it; junk is refused', async () => {
  const { h, a, b } = await two()
  const id = crypto.randomUUID()
  await h.request('PUT', `/api/attachments/${id}`, { token: a, body: { blob: sealedBlob('f') } })
  assert.equal((await h.request('GET', `/api/attachments/${id}`, { token: b })).status, 404)
  await h.request('DELETE', `/api/attachments/${id}`, { token: b })
  assert.equal((await h.request('GET', `/api/attachments/${id}`, { token: a })).status, 200, 'still there')
  assert.equal((await h.request('PUT', `/api/attachments/${crypto.randomUUID()}`, { token: a, body: { blob: 'plain text' } })).status, 400)
  assert.equal((await h.request('PUT', '/api/attachments/not-an-id!', { token: a, body: { blob: sealedBlob('f') } })).status, 400)
  assert.equal((await h.request('PUT', `/api/attachments/${crypto.randomUUID()}`, { body: { blob: sealedBlob('f') } })).status, 401)
})

test('the quota refuses a file that would go over it', async () => {
  const { h, a, aId } = await two()
  // Fill most of the quota directly, as if many files were stored.
  await h.store.put({ pk: `USER#${aId}`, sk: `ATT#${crypto.randomUUID()}`, bytes: ATTACHMENT_QUOTA_BYTES - 1000, blob: 'v1.a.b' })
  const res = await h.request('PUT', `/api/attachments/${crypto.randomUUID()}`, { token: a, body: { blob: sealedBlob('big', 4096) } })
  assert.equal(res.status, 413)
  assert.match(String(res.body['message']), /limited to 100 MB/)
})

test('personal backups carry attachments, so a restore has the files', async () => {
  const { h, a, aId } = await two()
  const id = crypto.randomUUID()
  await h.request('PUT', `/api/attachments/${id}`, { token: a, body: { blob: sealedBlob('kept') } })
  const file = JSON.parse((await buildFile(h.app, aId)).body.toString()) as { attachments: { id: string; blob: string }[] }
  assert.deepEqual(file.attachments.map((x) => x.id), [id])
})

test('deleting the account deletes its attachments', async () => {
  const { h, a, aId } = await two()
  await h.request('PUT', `/api/attachments/${crypto.randomUUID()}`, { token: a, body: { blob: sealedBlob('gone') } })
  await h.request('POST', '/api/account/delete', { token: a, body: { currentAuthKey: fixtureB64('auth-key'), confirm: 'DELETE' } })
  assert.ok(!h.store.dump().some((r) => r.pk === `USER#${aId}` && r.sk.startsWith('ATT#')))
})
