// Emergency access with the real cryptography: a trusted contact is invited,
// accepts, is confirmed by fingerprint, requests access, waits, and then reads
// the grantor's vault — unless the grantor rejects in time.

import test from 'node:test'
import assert from 'node:assert/strict'

import { generateIdentityKeyPair, generateVaultKey, openEmergencyKey, openEntry, sealEmergencyKey, sealEntry, toBase64Url } from '@vault/crypto'

import { harness, registration, sealedBlob } from './harness.js'

type H = ReturnType<typeof harness>
async function person(h: H, email: string) {
  const keys = await generateIdentityKeyPair()
  const res = await h.request('POST', '/api/auth/register', { body: registration({ email, identity: { publicKey: toBase64Url(keys.publicKey), wrappedPrivateKey: sealedBlob(`${email}-pk`, 160) } }) })
  return { keys, token: String(res.body['accessToken']), userId: String(res.body['userId']) }
}
const DAY = 86_400_000

async function setUp(h: H) {
  const asha = await person(h, 'asha@example.test')
  const ravi = await person(h, 'ravi@example.test')
  const vaultKey = generateVaultKey()
  const entryId = crypto.randomUUID()
  await h.request('PUT', `/api/vault/entries/${entryId}`, { token: asha.token, body: { blob: await sealEntry(entryId, { name: 'Bank', type: 'login', password: 'p', tags: [], customFields: [], favorite: false }, vaultKey) } })
  const created = await h.request('POST', '/api/emergency', { token: asha.token, body: { email: 'ravi@example.test', label: 'Ravi', fromName: 'Asha', waitDays: 3 } })
  const id = String(created.body['id'])
  const t = (await h.request('GET', '/api/emergency/trusted', { token: ravi.token })).body as { invitations: { id: string; fromName: string }[] }
  assert.deepEqual(t.invitations.map((i) => i.fromName), ['Asha'])
  await h.request('POST', `/api/emergency/${id}/accept`, { token: ravi.token })
  const g = ((await h.request('GET', '/api/emergency', { token: asha.token })).body['grants'] as { granteePublicKey: string }[])[0]!
  assert.equal(g.granteePublicKey, toBase64Url(ravi.keys.publicKey), 'Asha sees the key Ravi accepted with')
  await h.request('POST', `/api/emergency/${id}/confirm`, { token: asha.token, body: { keyBlob: await sealEmergencyKey(ravi.keys.publicKey, vaultKey, id) } })
  return { asha, ravi, vaultKey, entryId, id }
}

test('a request opens after the wait, and the contact reads the vault read-only', async () => {
  const h = harness()
  const { asha, ravi, vaultKey, entryId, id } = await setUp(h)
  assert.equal((await h.request('GET', `/api/emergency/${id}/vault`, { token: ravi.token })).status, 403, 'nothing before a request')
  assert.equal((await h.request('POST', `/api/emergency/${id}/request`, { token: ravi.token })).status, 200)
  const early = await h.request('GET', `/api/emergency/${id}/vault`, { token: ravi.token })
  assert.equal(early.status, 403)
  assert.match(String(early.body['message']), /opens/)

  h.setNow(h.app.now() + 3 * DAY + 1000)
  // Tokens expire with the clock; sign in again as both.
  const login = async (email: string) => String((await h.request('POST', '/api/auth/login', { body: { email, authKey: (registration() as { authKey: string }).authKey } })).body['accessToken'])
  const raviToken = await login('ravi@example.test')
  const res = await h.request('GET', `/api/emergency/${id}/vault`, { token: raviToken })
  assert.equal(res.status, 200)
  const key = await openEmergencyKey(ravi.keys.privateKey, ravi.keys.publicKey, String(res.body['keyBlob']), id)
  assert.deepEqual(key, vaultKey)
  const entries = res.body['entries'] as { id: string; blob: string }[]
  assert.equal((await openEntry(entries[0]!.id, entries[0]!.blob, key)).name, 'Bank')
  assert.equal(entries[0]!.id, entryId)
  const activity = (await h.request('GET', '/api/activity', { token: await login('asha@example.test') })).body['events'] as { kind: string }[]
  assert.ok(activity.some((e) => e.kind === 'emergency-request'))
  assert.ok(activity.some((e) => e.kind === 'emergency-access'))
  void asha
})

test('the grantor can reject during the wait, or revoke the contact', async () => {
  const h = harness()
  const { asha, ravi, id } = await setUp(h)
  await h.request('POST', `/api/emergency/${id}/request`, { token: ravi.token })
  assert.equal((await h.request('POST', `/api/emergency/${id}/reject`, { token: asha.token })).status, 200)
  assert.equal(((await h.request('GET', '/api/emergency/trusted', { token: ravi.token })).body['grants'] as { status: string }[])[0]!.status, 'rejected')
  assert.equal((await h.request('DELETE', `/api/emergency/${id}`, { token: asha.token })).status, 200)
  assert.equal((await h.request('GET', `/api/emergency/${id}/vault`, { token: ravi.token })).status, 404)
})

test('strangers cannot touch a grant, and approval opens access at once', async () => {
  const h = harness()
  const { asha, ravi, id } = await setUp(h)
  const eve = await person(h, 'eve@example.test')
  assert.equal((await h.request('POST', `/api/emergency/${id}/request`, { token: eve.token })).status, 404)
  assert.equal((await h.request('POST', `/api/emergency/${id}/approve`, { token: ravi.token })).status, 404, 'the contact cannot approve themselves')
  await h.request('POST', `/api/emergency/${id}/request`, { token: ravi.token })
  await h.request('POST', `/api/emergency/${id}/approve`, { token: asha.token })
  assert.equal((await h.request('GET', `/api/emergency/${id}/vault`, { token: ravi.token })).status, 200)
})
