// Argon2id key settings (decisions/0028): accepted within limits at sign-up
// and on change, returned at sign-in, mixed into decoys, and an upgrade is
// labelled as one.

import test from 'node:test'
import assert from 'node:assert/strict'

import { fixtureB64, harness, registration } from './harness.js'

const ARGON = { algorithm: 'argon2id', m: 65_536, t: 3, p: 1, salt: fixtureB64('kdf-salt') }

test('an account can be made with Argon2id, and sign-in hands its settings back', async () => {
  const h = harness({ allowRegistration: true })
  const reg = await h.request('POST', '/api/auth/register', { body: registration({ email: 'argon@example.test', kdf: ARGON }) })
  assert.equal(reg.status, 201)
  assert.deepEqual((await h.request('POST', '/api/auth/prelogin', { body: { email: 'argon@example.test' } })).body['kdf'], ARGON)
  const login = await h.request('POST', '/api/auth/login', { body: { email: 'argon@example.test', authKey: fixtureB64('auth-key') } })
  assert.deepEqual(login.body['kdf'], ARGON)
})

test('Argon2id settings outside the limits are refused', async () => {
  const h = harness({ allowRegistration: true })
  for (const bad of [
    { ...ARGON, m: 8192 },
    { ...ARGON, m: 19_456, t: 1 },
    { ...ARGON, m: 2_097_152 },
    { ...ARGON, t: 11 },
    { ...ARGON, p: 8 },
    { ...ARGON, m: '65536' },
    { ...ARGON, algorithm: 'argon2i' },
    { ...ARGON, salt: fixtureB64('x').slice(0, 10) },
  ]) {
    const res = await h.request('POST', '/api/auth/register', { body: registration({ email: 'bad@example.test', kdf: bad }) })
    assert.equal(res.status, 400, JSON.stringify(bad))
  }
  assert.equal((await h.request('POST', '/api/auth/register', { body: registration({ email: 'ok@example.test', kdf: { ...ARGON, m: 47_104, t: 1 } }) })).status, 201, 'OWASP\'s one-pass setting')
})

test('upgrading from PBKDF2 keeps the account and says so in activity', async () => {
  const h = harness({ allowRegistration: true })
  const reg = (await h.request('POST', '/api/auth/register', { body: registration({ email: 'old@example.test' }) })).body
  const res = await h.request('POST', '/api/auth/change-password', {
    token: String(reg['accessToken']),
    body: { currentAuthKey: fixtureB64('auth-key'), newAuthKey: fixtureB64('new-auth'), kdf: { ...ARGON, salt: fixtureB64('new-salt') }, wrappedVaultKey: String(registration()['wrappedVaultKey']), purpose: 'upgrade-kdf' },
  })
  assert.equal(res.status, 200)
  const token = String(res.body['accessToken'])
  const events = ((await h.request('GET', '/api/activity', { token })).body['events'] as { kind: string }[]).map((e) => e.kind)
  assert.ok(events.includes('upgrade-kdf'))
  assert.equal(((await h.request('GET', '/api/auth/me', { token })).body['kdf'] as { algorithm: string }).algorithm, 'argon2id')
})

test('decoys for unknown addresses claim both algorithms, stably', async () => {
  const h = harness()
  const algos = new Set<string>()
  for (let i = 0; i < 24; i++) {
    const email = `nobody${i}@example.test`
    const a = (await h.request('POST', '/api/auth/prelogin', { ip: `198.51.100.${i}`, body: { email } })).body['kdf'] as { algorithm: string }
    const b = (await h.request('POST', '/api/auth/prelogin', { ip: `198.51.100.${i}`, body: { email } })).body['kdf'] as { algorithm: string }
    assert.deepEqual(a, b)
    algos.add(a.algorithm)
  }
  assert.deepEqual([...algos].sort(), ['PBKDF2-HMAC-SHA256', 'argon2id'])
})
