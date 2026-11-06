// Two-factor sign-in: turning it on, signing in with it, recovery codes,
// replay, turning it off, and the admin reset.

import test from 'node:test'
import assert from 'node:assert/strict'

import { generateTotp } from '@vault/crypto'

import { fixtureB64, harness, registration } from './harness.js'

const EMAIL = 'person@example.com'
const AUTH = fixtureB64('auth-key')

async function withTwoFactor(options: { adminEmails?: string[] } = {}) {
  const h = harness(options)
  const reg = await h.request('POST', '/api/auth/register', { body: registration() })
  const token = String(reg.body['accessToken'])
  const userId = String(reg.body['userId'])
  const setup = await h.request('POST', '/api/auth/2fa/setup', { token, body: { currentAuthKey: AUTH } })
  assert.equal(setup.status, 200)
  const secret = String(setup.body['secret'])
  let now = Date.UTC(2026, 8, 22, 12, 0, 0)
  const code = async () => (await generateTotp(secret, now)).code
  const advance = () => { now += 30_000; h.setNow(now) }
  const enable = await h.request('POST', '/api/auth/2fa/enable', { token, body: { code: await code() } })
  assert.equal(enable.status, 200)
  const recoveryCodes = enable.body['recoveryCodes'] as string[]
  return { h, token, userId, secret, code, advance, recoveryCodes }
}

const login = (h: ReturnType<typeof harness>, extra: Record<string, unknown> = {}) =>
  h.request('POST', '/api/auth/login', { body: { email: EMAIL, authKey: AUTH, ...extra } })

test('setup needs the current password', async () => {
  const h = harness()
  const reg = await h.request('POST', '/api/auth/register', { body: registration() })
  const res = await h.request('POST', '/api/auth/2fa/setup', { token: String(reg.body['accessToken']), body: { currentAuthKey: fixtureB64('wrong') } })
  assert.equal(res.status, 401)
})

test('a wrong code does not turn it on', async () => {
  const h = harness()
  const reg = await h.request('POST', '/api/auth/register', { body: registration() })
  const token = String(reg.body['accessToken'])
  await h.request('POST', '/api/auth/2fa/setup', { token, body: { currentAuthKey: AUTH } })
  const res = await h.request('POST', '/api/auth/2fa/enable', { token, body: { code: '000000' } })
  assert.equal(res.status, 401)
  assert.equal((await h.request('GET', '/api/auth/me', { token })).body['twoFactor'] && ((await h.request('GET', '/api/auth/me', { token })).body['twoFactor'] as Record<string, unknown>)['enabled'], false)
})

test('once on, signing in needs the code, and the password alone gets nothing', async () => {
  const { h, code, advance, recoveryCodes } = await withTwoFactor()
  assert.equal(recoveryCodes.length, 10)
  const bare = await login(h)
  assert.equal(bare.status, 401)
  assert.equal(bare.body['error'], 'two_factor_required')
  assert.equal(bare.body['wrappedVaultKey'], undefined)
  assert.equal(bare.body['accessToken'], undefined)

  advance()
  const ok = await login(h, { totpCode: await code() })
  assert.equal(ok.status, 200)
  assert.ok(typeof ok.body['wrappedVaultKey'] === 'string')
})

test('a code is refused when the password is wrong, without revealing two-factor', async () => {
  const { h, code } = await withTwoFactor()
  const res = await h.request('POST', '/api/auth/login', { body: { email: EMAIL, authKey: fixtureB64('wrong'), totpCode: await code() } })
  assert.equal(res.status, 401)
  assert.equal(res.body['error'], 'invalid_credentials')
})

test('a code cannot be used twice', async () => {
  const { h, code, advance } = await withTwoFactor()
  advance()
  const c = await code()
  assert.equal((await login(h, { totpCode: c })).status, 200)
  const replay = await login(h, { totpCode: c })
  assert.equal(replay.status, 401)
  assert.equal(replay.body['error'], 'invalid_two_factor')
})

test('a recovery code works once', async () => {
  const { h, recoveryCodes } = await withTwoFactor()
  const rc = recoveryCodes[0]!
  assert.equal((await login(h, { recoveryCode: rc.toLowerCase() })).status, 200)
  assert.equal((await login(h, { recoveryCode: rc })).status, 401)
})

test('recovery codes are stored hashed, and the TOTP key sealed', async () => {
  const { h, secret, recoveryCodes } = await withTwoFactor()
  const dump = JSON.stringify(h.store.dump())
  assert.ok(!dump.includes(secret))
  for (const rc of recoveryCodes) assert.ok(!dump.includes(rc))
})

test('signing in with the recovery key also needs the second factor', async () => {
  const { h, code, advance } = await withTwoFactor()
  const reg = registration()
  const bare = await h.request('POST', '/api/auth/recovery-login', { body: { email: EMAIL, recoveryAuthKey: reg['recoveryAuthKey'] } })
  assert.equal(bare.body['error'], 'two_factor_required')
  advance()
  const ok = await h.request('POST', '/api/auth/recovery-login', { body: { email: EMAIL, recoveryAuthKey: reg['recoveryAuthKey'], totpCode: await code() } })
  assert.equal(ok.status, 200)
})

test('turning it off needs the password and a code', async () => {
  const { h, token, code, advance } = await withTwoFactor()
  advance()
  assert.equal((await h.request('POST', '/api/auth/2fa/disable', { token, body: { currentAuthKey: AUTH } })).status, 401)
  assert.equal((await h.request('POST', '/api/auth/2fa/disable', { token, body: { currentAuthKey: AUTH, totpCode: await code() } })).status, 200)
  assert.equal((await login(h)).status, 200)
})

test('new recovery codes replace the old ones', async () => {
  const { h, token, code, advance, recoveryCodes } = await withTwoFactor()
  advance()
  const res = await h.request('POST', '/api/auth/2fa/recovery-codes', { token, body: { currentAuthKey: AUTH, totpCode: await code() } })
  assert.equal(res.status, 200)
  const fresh = res.body['recoveryCodes'] as string[]
  assert.equal((await login(h, { recoveryCode: recoveryCodes[1] })).status, 401)
  assert.equal((await login(h, { recoveryCode: fresh[0] })).status, 200)
})

test('an admin can reset a member who lost their phone and codes, and it is audited', async () => {
  const h = harness({ adminEmails: ['owner@example.com'], allowRegistration: true })
  const owner = await h.request('POST', '/api/auth/register', { body: registration({ email: 'owner@example.com', authKey: fixtureB64('owner') }) })
  const ownerToken = String(owner.body['accessToken'])
  const reg = await h.request('POST', '/api/auth/register', { body: registration() })
  const token = String(reg.body['accessToken'])
  const userId = String(reg.body['userId'])
  const setup = await h.request('POST', '/api/auth/2fa/setup', { token, body: { currentAuthKey: AUTH } })
  await h.request('POST', '/api/auth/2fa/enable', { token, body: { code: (await generateTotp(String(setup.body['secret']), Date.UTC(2026, 8, 22, 12, 0, 0))).code } })
  assert.equal((await login(h)).status, 401)

  const users = (await h.request('GET', '/api/admin/users', { token: ownerToken })).body['users'] as Array<Record<string, unknown>>
  assert.equal(users.find((u) => u['userId'] === userId)?.['twoFactor'], true)

  assert.equal((await h.request('POST', `/api/admin/users/${userId}/reset-2fa`, { token: ownerToken })).status, 200)
  assert.equal((await login(h)).status, 200)
  const audit = (await h.request('GET', '/api/admin/audit', { token: ownerToken })).body['records'] as Array<Record<string, unknown>>
  assert.ok(audit.some((r) => r['action'] === 'user.reset-2fa'))
})
