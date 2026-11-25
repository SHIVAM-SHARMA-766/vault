// Unlock with a passkey (decisions/0034): enrolling needs the master password
// and a verifying, discoverable passkey; signing in names no account, needs
// user verification, uses each challenge once, and still obeys disabled
// accounts and the network allow-list.

import test from 'node:test'
import assert from 'node:assert/strict'

import { fixtureB64, harness, registration, sealedBlob } from './harness.js'
import { SoftAuthenticator } from './soft-authenticator.js'

const AUTH = fixtureB64('auth-key')
const EMAIL = 'pk@example.test'
const WRAPPED = sealedBlob('passkey-wrapped', 48)
const SEALED_EMAIL = sealedBlob('passkey-email', 32)

async function setup(opts: Parameters<typeof harness>[0] = {}) {
  const h = harness({ allowRegistration: true, ...opts })
  const reg = (await h.request('POST', '/api/auth/register', { body: registration({ email: EMAIL }) })).body
  return { h, token: String(reg['accessToken']), userId: String(reg['userId']) }
}

type H = ReturnType<typeof harness>
// Each sign-in costs two requests against the per-address limit; tests spread them out.
let host = 10
const nextIp = () => `203.0.113.${host++}`

async function enrol(h: H, token: string, key: SoftAuthenticator, extra: { uv?: boolean; name?: string } = {}) {
  const opts = await h.request('POST', '/api/auth/passkeys/options', { token, body: { currentAuthKey: AUTH } })
  assert.equal(opts.status, 200)
  const options = opts.body['options'] as { challenge: string; authenticatorSelection: { residentKey: string; userVerification: string } }
  assert.deepEqual([options.authenticatorSelection.residentKey, options.authenticatorSelection.userVerification], ['required', 'required'])
  return h.request('POST', '/api/auth/passkeys', {
    token, body: { name: extra.name ?? 'Phone', response: key.register(options, { uv: extra.uv ?? true }), wrappedVaultKey: WRAPPED, sealedEmail: SEALED_EMAIL },
  })
}

async function signIn(h: H, key: SoftAuthenticator, userId: string, opts: { uv?: boolean; ip?: string; reuse?: { challenge: string } } = {}): Promise<{ options: { challenge: string; allowCredentials?: unknown[]; userVerification?: string }; res: Awaited<ReturnType<H["request"]>> }> {
  const ip = opts.ip ?? nextIp()
  const options = opts.reuse ?? (await h.request('POST', '/api/auth/passkey-login/options', { ip, body: {} })).body['options'] as { challenge: string; allowCredentials: unknown[]; userVerification: string }
  return { options, res: await h.request('POST', '/api/auth/passkey-login', { ip, body: { response: key.assert(options, { uv: opts.uv ?? true, userHandle: userId }) } }) }
}

test('enrolling needs the master password and a passkey that verifies its user', async () => {
  const { h, token } = await setup()
  assert.equal((await h.request('POST', '/api/auth/passkeys/options', { token, body: { currentAuthKey: fixtureB64('wrong') } })).status, 401)
  assert.equal((await enrol(h, token, new SoftAuthenticator(), { uv: false })).status, 400, 'no user verification, no passkey')
  const key = new SoftAuthenticator()
  const added = await enrol(h, token, key)
  assert.equal(added.status, 201)
  const me = (await h.request('GET', '/api/auth/me', { token })).body
  assert.deepEqual((me['passkeys'] as { name: string }[]).map((k) => k.name), ['Phone'])
  assert.equal(JSON.stringify(me).includes(WRAPPED), false, 'the wrapped key is not listed')
  assert.equal((me['twoFactor'] as { enabled: boolean }).enabled, false, 'an unlock passkey is not a second factor')
  assert.equal((await enrol(h, token, key)).status, 409, 'the same passkey twice')
  const bad = await h.request('POST', '/api/auth/passkeys', { token, body: { response: {}, wrappedVaultKey: 'nope', sealedEmail: SEALED_EMAIL } })
  assert.equal(bad.status, 400)
})

test('signing in names no account and returns the wrapping, once per challenge', async () => {
  const { h, token, userId } = await setup()
  const key = new SoftAuthenticator()
  await enrol(h, token, key)
  const { options, res } = await signIn(h, key, userId)
  assert.deepEqual([options.allowCredentials, options.userVerification], [[], 'required'])
  assert.equal(res.status, 200)
  assert.deepEqual([res.body['wrappedVaultKey'], res.body['sealedEmail'], res.body['credentialId']], [WRAPPED, SEALED_EMAIL, key.id.toString('base64url')])
  assert.ok(res.body['accessToken'] && res.body['refreshToken'])
  assert.equal(((await h.request('GET', '/api/activity', { token })).body['events'] as { kind: string }[]).some((e) => e.kind === 'passkey-login'), true)
  const again = await signIn(h, key, userId, { reuse: options })
  assert.equal(again.res.status, 401, 'the challenge is used up')
  assert.equal(((await h.request('GET', '/api/auth/me', { token })).body['passkeys'] as { lastUsedAt: string | null }[])[0]!.lastUsedAt !== null, true)
})

test('without user verification, with a stranger\'s passkey, or a stale challenge, it is refused', async () => {
  const { h, token, userId } = await setup()
  const key = new SoftAuthenticator()
  await enrol(h, token, key)
  assert.equal((await signIn(h, key, userId, { uv: false })).res.status, 401)
  assert.equal((await signIn(h, new SoftAuthenticator(), userId)).res.status, 401, 'a passkey this account never enrolled')
  assert.equal((await signIn(h, key, 'someone-else')).res.status, 401, 'another account\'s handle')
  // A security key added as a second factor does not unlock.
  const second = new SoftAuthenticator()
  const o = await h.request('POST', '/api/auth/2fa/webauthn/options', { token, body: { currentAuthKey: AUTH } })
  await h.request('POST', '/api/auth/2fa/webauthn', { token, body: { name: 'YubiKey', response: second.register(o.body['options'] as { challenge: string }) } })
  assert.equal((await signIn(h, second, userId)).res.status, 401)
  const opts = (await h.request('POST', '/api/auth/passkey-login/options', { body: {} })).body['options'] as { challenge: string }
  h.setNow(Date.UTC(2026, 8, 22, 12, 10, 0))
  assert.equal((await signIn(h, key, userId, { reuse: opts })).res.status, 401, 'five minutes, then the challenge is gone')
  // The second factor is not asked for: the passkey is both.
  assert.equal((await signIn(h, key, userId)).res.status, 200)
  // The same per-address limit as a password sign-in.
  const codes = []
  for (let i = 0; i < 11; i++) codes.push((await h.request('POST', '/api/auth/passkey-login/options', { ip: '192.0.2.50', body: {} })).status)
  assert.equal(codes.at(-1), 429)
})

test('a disabled account or a blocked network cannot sign in with a passkey; removing it ends it', async () => {
  const h = harness({ adminEmails: ['owner@example.com'], allowRegistration: true })
  const owner = String((await h.request('POST', '/api/auth/register', { body: registration({ email: 'owner@example.com', authKey: fixtureB64('owner') }) })).body['accessToken'])
  const reg = (await h.request('POST', '/api/auth/register', { body: registration({ email: EMAIL }) })).body
  const token = String(reg['accessToken']); const userId = String(reg['userId'])
  const key = new SoftAuthenticator()
  await enrol(h, token, key)

  assert.equal((await h.request('PUT', '/api/admin/settings', { token: owner, body: { policy: { requireTwoFactor: false, minPasswordScore: 0, maxIdleMinutes: null, sessionDays: null, activityDays: 90, auditDays: 365, shareLinks: true, shareLinkMaxDays: 30, allowedNetworks: ['203.0.113.0/24'] } } })).status, 200)
  assert.equal((await signIn(h, key, userId, { ip: '198.51.100.9' })).res.body['error'], 'network_not_allowed')
  assert.equal((await signIn(h, key, userId)).res.status, 200, 'from inside the allowed network')

  await h.request('PUT', `/api/admin/users/${userId}/disabled`, { token: owner, body: { disabled: true } })
  assert.equal((await signIn(h, key, userId)).res.status, 403)
  await h.request('PUT', `/api/admin/users/${userId}/disabled`, { token: owner, body: { disabled: false } })

  const fresh = String((await signIn(h, key, userId)).res.body['accessToken'])
  assert.equal((await h.request('DELETE', `/api/auth/passkeys/${key.id.toString('base64url')}`, { token: fresh })).status, 200)
  assert.equal((await h.request('DELETE', `/api/auth/passkeys/${key.id.toString('base64url')}`, { token: fresh })).status, 404)
  assert.equal((await signIn(h, key, userId)).res.status, 401)
  assert.deepEqual((await h.request('GET', '/api/auth/me', { token: fresh })).body['passkeys'], [])
})
