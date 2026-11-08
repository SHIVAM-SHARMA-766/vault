// The opt-in secret key (decisions/0027). The server never sees the key; it
// stores and returns `kdf.version`, audits turning it on and off, and makes an
// unknown address sometimes claim one too, so the flag does not reveal accounts.

import test from 'node:test'
import assert from 'node:assert/strict'

import { fixtureB64, harness, registration, sealedBlob } from './harness.js'

const b64 = (label: string) => fixtureB64(`secret-key-test.${label}`)
const kdf = (label: string, version?: number) => ({ algorithm: 'PBKDF2-HMAC-SHA256', iterations: 600_000, salt: b64(label), ...(version === undefined ? {} : { version }) })

test('turning the secret key on and off is kept, handed back at prelogin, and audited', async () => {
  const h = harness()
  const reg = registration()
  const token = String((await h.request('POST', '/api/auth/register', { body: reg })).body['accessToken'])

  const on = await h.request('POST', '/api/auth/change-password', {
    token, body: { currentAuthKey: reg['authKey'], newAuthKey: b64('a1'), kdf: kdf('s1', 2), wrappedVaultKey: sealedBlob('w1', 48) },
  })
  assert.equal(on.status, 200)
  assert.equal(((await h.request('POST', '/api/auth/prelogin', { body: { email: reg['email'] } })).body['kdf'] as { version?: number }).version, 2)

  const off = await h.request('POST', '/api/auth/change-password', {
    token: String(on.body['accessToken']), body: { currentAuthKey: b64('a1'), newAuthKey: b64('a2'), kdf: kdf('s2'), wrappedVaultKey: sealedBlob('w2', 48) },
  })
  assert.equal(off.status, 200)
  assert.equal(((await h.request('POST', '/api/auth/prelogin', { body: { email: reg['email'] } })).body['kdf'] as { version?: number }).version, undefined)

  const activity = await h.request('GET', '/api/activity', { token: String(off.body['accessToken']) })
  const actions = activity.body['events'] as { kind: string }[]
  assert.ok(actions.some((a) => a.kind === 'add-secret-key'))
  assert.ok(actions.some((a) => a.kind === 'remove-secret-key'))
})

test('a version other than 2 is refused', async () => {
  const h = harness()
  assert.equal((await h.request('POST', '/api/auth/register', { body: registration({ kdf: kdf('s3', 3) }) })).status, 400)
  assert.equal((await h.request('POST', '/api/auth/register', { body: registration({ kdf: kdf('s4', 2) }) })).status, 201)
})

test('some unknown addresses claim a secret key, each always the same way', async () => {
  const { decoyHasSecretKey } = await import('../src/identity.js')
  const answers = Array.from({ length: 400 }, (_, i) => decoyHasSecretKey(`nobody-${i}@example.com`, 'pepper'))
  const yes = answers.filter(Boolean).length
  assert.ok(yes > 20 && yes < 90, `${yes} of 400, about one in eight`)
  assert.equal(decoyHasSecretKey('Nobody-1@Example.com ', 'pepper'), answers[1], 'stable, after normalising')

  // Through the route: an unknown address answers the same way twice.
  const h = harness()
  const email = 'nobody-7@example.com'
  const first = (await h.request('POST', '/api/auth/prelogin', { body: { email } })).body['kdf']
  const second = (await h.request('POST', '/api/auth/prelogin', { body: { email } })).body['kdf']
  assert.deepEqual(first, second)
})
