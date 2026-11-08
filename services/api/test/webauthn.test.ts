// Passkeys and security keys as a second factor (D9): adding one needs the
// master password; sign-in then asks for it; a wrong origin, a replayed
// challenge or another key fails; recovery codes still work; removing the
// last factor turns two-factor off.

import test from 'node:test'
import assert from 'node:assert/strict'

import { fixtureB64, harness, registration } from './harness.js'
import { SoftAuthenticator } from './soft-authenticator.js'

const AUTH = fixtureB64('auth-key')
const EMAIL = 'keys@example.test'

async function setup() {
  const h = harness({ allowRegistration: true })
  const token = String((await h.request('POST', '/api/auth/register', { body: registration({ email: EMAIL }) })).body['accessToken'])
  return { h, token }
}

async function addKey(h: ReturnType<typeof harness>, token: string, key: SoftAuthenticator, name = 'YubiKey') {
  const opts = await h.request('POST', '/api/auth/2fa/webauthn/options', { token, body: { currentAuthKey: AUTH } })
  assert.equal(opts.status, 200)
  return h.request('POST', '/api/auth/2fa/webauthn', { token, body: { name, response: key.register(opts.body['options'] as { challenge: string }) } })
}

const login = (h: ReturnType<typeof harness>, extra: Record<string, unknown> = {}) =>
  h.request('POST', '/api/auth/login', { body: { email: EMAIL, authKey: AUTH, ...extra } })

test('adding a key needs the master password, and the first one brings recovery codes', async () => {
  const { h, token } = await setup()
  assert.equal((await h.request('POST', '/api/auth/2fa/webauthn/options', { token, body: { currentAuthKey: fixtureB64('wrong') } })).status, 401)
  const added = await addKey(h, token, new SoftAuthenticator())
  assert.equal(added.status, 201)
  assert.equal((added.body['recoveryCodes'] as string[]).length, 10)
  const me = (await h.request('GET', '/api/auth/me', { token })).body['twoFactor'] as { enabled: boolean; totp: boolean; keys: { name: string }[] }
  assert.deepEqual([me.enabled, me.totp, me.keys.map((k) => k.name)], [true, false, ['YubiKey']])
  const second = await addKey(h, token, new SoftAuthenticator(), 'Laptop')
  assert.equal(second.body['recoveryCodes'], undefined, 'codes only with the first factor')
})

test('sign-in asks for the key, offers its options, and accepts its answer once', async () => {
  const { h, token } = await setup()
  const key = new SoftAuthenticator()
  await addKey(h, token, key)
  const first = await login(h)
  assert.equal(first.status, 401)
  assert.equal(first.body['error'], 'two_factor_required')
  const details = first.body['details'] as { methods: string[]; webauthn: { challenge: string; allowCredentials: { id: string }[] } }
  assert.deepEqual(details.methods, ['webauthn', 'recovery'])
  assert.equal(details.webauthn.allowCredentials[0]!.id, key.id.toString('base64url'))
  const answer = key.assert(details.webauthn)
  assert.equal((await login(h, { webauthn: answer })).status, 200)
  assert.equal((await login(h, { webauthn: answer })).status, 401, 'the challenge is used up')
})

test('a wrong origin, a stale challenge or an unknown key is refused', async () => {
  const { h, token } = await setup()
  const key = new SoftAuthenticator()
  await addKey(h, token, key)
  let opts = ((await login(h)).body['details'] as { webauthn: { challenge: string } }).webauthn
  assert.equal((await login(h, { webauthn: key.assert(opts, { origin: 'https://phish.example' }) })).status, 401, 'phishing origin')
  opts = ((await login(h)).body['details'] as { webauthn: { challenge: string } }).webauthn
  assert.equal((await login(h, { webauthn: new SoftAuthenticator().assert(opts) })).status, 401, 'a key that is not registered')
  opts = ((await login(h)).body['details'] as { webauthn: { challenge: string } }).webauthn
  h.setNow(h.app.now() + 6 * 60_000)
  assert.equal((await login(h, { webauthn: key.assert(opts) })).status, 401, 'challenge older than five minutes')
})

test('recovery codes still sign in; removing the last key turns two-factor off', async () => {
  const { h, token } = await setup()
  const key = new SoftAuthenticator()
  const codes = (await addKey(h, token, key)).body['recoveryCodes'] as string[]
  assert.equal((await login(h, { recoveryCode: codes[0] })).status, 200)
  const id = key.id.toString('base64url')
  // Removing needs the password and a second factor.
  const ask = await h.request('POST', `/api/auth/2fa/webauthn/${id}/remove`, { token, body: { currentAuthKey: AUTH } })
  assert.equal(ask.status, 401)
  const opts = (ask.body['details'] as { webauthn: { challenge: string } }).webauthn
  assert.equal((await h.request('POST', `/api/auth/2fa/webauthn/${id}/remove`, { token, body: { currentAuthKey: AUTH, webauthn: key.assert(opts) } })).status, 200)
  const me = (await h.request('GET', '/api/auth/me', { token })).body['twoFactor'] as { enabled: boolean; recoveryCodesLeft: number }
  assert.deepEqual([me.enabled, me.recoveryCodesLeft], [false, 0])
  assert.equal((await login(h)).status, 200, 'no second factor asked any more')
})

test('a key satisfies a "require two-factor" policy', async () => {
  const h = harness({ allowRegistration: true, adminEmails: ['owner@example.test'] })
  const owner = String((await h.request('POST', '/api/auth/register', { body: registration({ email: 'owner@example.test', authKey: fixtureB64('o') }) })).body['accessToken'])
  const token = String((await h.request('POST', '/api/auth/register', { body: registration({ email: EMAIL }) })).body['accessToken'])
  await h.request('PUT', '/api/admin/settings', { token: owner, body: { policy: { requireTwoFactor: true, minPasswordScore: 0, maxIdleMinutes: null, sessionDays: null, activityDays: 90, auditDays: 365, shareLinks: true, shareLinkMaxDays: 30, allowedNetworks: [] } } })
  assert.match(String((await h.request('GET', '/api/auth/me', { token })).body['policyGap']), /two-factor/)
  await addKey(h, token, new SoftAuthenticator())
  assert.equal((await h.request('GET', '/api/auth/me', { token })).body['policyGap'], null)
})
