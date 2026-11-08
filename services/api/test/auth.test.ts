// The authentication surface, driven end to end against an in-memory store.

import test from 'node:test'
import assert from 'node:assert/strict'

import { fixtureB64, harness, registration } from './harness.js'

test('health needs no authentication', async () => {
  const h = harness()
  const res = await h.request('GET', '/api/health')
  assert.equal(res.status, 200)
  assert.equal(res.body['status'], 'ok')
})

test('registration issues a session and stores the wrapped keys', async () => {
  const h = harness()
  const res = await h.request('POST', '/api/auth/register', { body: registration() })

  assert.equal(res.status, 201)
  assert.ok(typeof res.body['accessToken'] === 'string')
  assert.ok(typeof res.body['refreshToken'] === 'string')
  assert.ok(typeof res.body['userId'] === 'string')
})

test('registration is refused when it is closed', async () => {
  const h = harness({ allowRegistration: false })
  const res = await h.request('POST', '/api/auth/register', { body: registration() })
  assert.equal(res.status, 403)
})

test('the same address cannot be registered twice, and the refusal does not say why', async () => {
  const h = harness()
  await h.request('POST', '/api/auth/register', { body: registration() })
  const second = await h.request('POST', '/api/auth/register', { body: registration() })
  assert.equal(second.status, 403)
  // Identical to a refused invitation, so an address's existence is not revealed (A7).
  h.app.allowRegistration = false
  const badInvite = await h.request('POST', '/api/auth/register', { body: registration({ email: 'new@example.test', inviteCode: 'NOPE-NOPE-NOPE' }) })
  assert.equal(badInvite.status, second.status)
  assert.equal(badInvite.body['message'], second.body['message'])
})

test('the address is never stored in the clear', async () => {
  // A dump of the table should say how many accounts exist and nothing about
  // whose. See docs/threat-model.md, A2.
  const h = harness()
  await h.request('POST', '/api/auth/register', { body: registration() })
  const dumped = JSON.stringify(h.store.dump())
  assert.ok(!dumped.includes('person@example.com'), 'no plaintext address anywhere in the table')
})

test('the master password never reaches the server', async () => {
  // Nothing in the registration payload is the password, and nothing derived
  // from it that could unwrap the vault is stored in a usable form.
  const h = harness()
  const payload = registration()
  assert.ok(!('password' in payload) && !('masterPassword' in payload))
  await h.request('POST', '/api/auth/register', { body: payload })

  const profile = h.store.dump().find((i) => i.sk === 'PROFILE')
  assert.ok(profile)
  // The auth key is stored only as an scrypt verifier, not as the value sent.
  assert.match(String(profile['authVerifier']), /^scrypt\$32768\$8\$1\$/)
  assert.ok(!JSON.stringify(profile).includes(String(payload['authKey'])))
})

test('login returns the wrapped vault key for the right credentials', async () => {
  const h = harness()
  const reg = registration()
  await h.request('POST', '/api/auth/register', { body: reg })

  const res = await h.request('POST', '/api/auth/login', {
    body: { email: reg['email'], authKey: reg['authKey'] },
  })
  assert.equal(res.status, 200)
  assert.equal(res.body['wrappedVaultKey'], reg['wrappedVaultKey'])
})

test('a wrong auth key is refused', async () => {
  const h = harness()
  const reg = registration()
  await h.request('POST', '/api/auth/register', { body: reg })

  const res = await h.request('POST', '/api/auth/login', {
    body: { email: reg['email'], authKey: fixtureB64('wrong-auth-key') },
  })
  assert.equal(res.status, 401)
  assert.equal(res.body['error'], 'invalid_credentials')
})

test('an unknown address and a wrong key are indistinguishable', async () => {
  // Otherwise the login endpoint tells an attacker which addresses have
  // accounts. See docs/threat-model.md, A7.
  const h = harness()
  const reg = registration()
  await h.request('POST', '/api/auth/register', { body: reg })

  const wrongKey = await h.request('POST', '/api/auth/login', {
    body: { email: reg['email'], authKey: fixtureB64('wrong-auth-key') },
  })
  const unknown = await h.request('POST', '/api/auth/login', {
    body: { email: 'nobody@example.com', authKey: String(reg['authKey']) },
  })

  assert.equal(wrongKey.status, unknown.status)
  // Everything but the per-request id, which differs for every response.
  const { requestId: _a, ...a } = wrongKey.body
  const { requestId: _b, ...b } = unknown.body
  assert.deepEqual(a, b)
})

test('prelogin returns a decoy salt for an unknown address', async () => {
  const h = harness()
  const res = await h.request('POST', '/api/auth/prelogin', {
    body: { email: 'nobody@example.com' },
  })
  assert.equal(res.status, 200)
  const kdf = res.body['kdf'] as Record<string, unknown>
  assert.equal(kdf['algorithm'], 'PBKDF2-HMAC-SHA256')
  assert.equal(kdf['iterations'], 600_000)
  assert.match(String(kdf['salt']), /^[A-Za-z0-9_-]+$/)
  assert.equal(Buffer.from(String(kdf['salt']), 'base64url').length, 32)
})

test('the decoy salt is stable for an address but differs between addresses', async () => {
  // Stable, or a client would see the salt change between attempts and learn
  // the account does not exist. Different, or every unknown address would
  // share one salt.
  const h = harness()
  const a1 = await h.request('POST', '/api/auth/prelogin', { body: { email: 'a@example.com' } })
  const a2 = await h.request('POST', '/api/auth/prelogin', { body: { email: 'a@example.com' } })
  const b = await h.request('POST', '/api/auth/prelogin', { body: { email: 'b@example.com' } })

  const salt = (r: typeof a1) => (r.body['kdf'] as Record<string, unknown>)['salt']
  assert.equal(salt(a1), salt(a2))
  assert.notEqual(salt(a1), salt(b))
})

test('a registered address returns its real salt', async () => {
  const h = harness()
  const reg = registration()
  await h.request('POST', '/api/auth/register', { body: reg })

  const res = await h.request('POST', '/api/auth/prelogin', { body: { email: reg['email'] } })
  const kdf = res.body['kdf'] as Record<string, unknown>
  assert.equal(kdf['salt'], (reg['kdf'] as Record<string, unknown>)['salt'])
})

test('addresses are matched case-insensitively', async () => {
  const h = harness()
  const reg = registration()
  await h.request('POST', '/api/auth/register', { body: reg })

  const res = await h.request('POST', '/api/auth/login', {
    body: { email: '  PERSON@Example.COM ', authKey: reg['authKey'] },
  })
  assert.equal(res.status, 200)
})

test('a weakened iteration count is refused', async () => {
  // The client is the thing an attacker controls, so the floor is enforced
  // here as well. A registration claiming 1,000 iterations would leave the
  // wrapped vault key open to offline attack.
  const h = harness()
  const res = await h.request('POST', '/api/auth/register', {
    body: registration({
      kdf: { algorithm: 'PBKDF2-HMAC-SHA256', iterations: 1_000, salt: fixtureB64('kdf-salt') },
    }),
  })
  assert.equal(res.status, 400)
  assert.match(String(res.body['message']), /at least 600000/)
})

test('malformed payloads are rejected before anything is stored', async () => {
  const h = harness()
  const cases: [string, Record<string, unknown>][] = [
    ['bad email', registration({ email: 'not-an-address' })],
    ['short auth key', registration({ authKey: fixtureB64('short', 16) })],
    ['unsealed wrapped key', registration({ wrappedVaultKey: 'not-a-blob' })],
    ['wrong kdf algorithm', registration({ kdf: { algorithm: 'scrypt', iterations: 600_000, salt: 'AAAA' } })],
  ]
  for (const [label, body] of cases) {
    const res = await h.request('POST', '/api/auth/register', { body })
    assert.equal(res.status, 400, label)
  }
  assert.equal(h.store.dump().filter((i) => i.sk === 'PROFILE').length, 0, 'nothing was stored')
})
