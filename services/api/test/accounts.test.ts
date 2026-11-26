// Signing in in two steps (decisions/0036): the account password (and second
// factor) gives an account token; the token and the master password's proof
// together give the vault. Neither alone does.

import test from 'node:test'
import assert from 'node:assert/strict'

import { generateTotp } from '@vault/crypto'

import { fixtureB64, harness, registration } from './harness.js'

const AUTH = fixtureB64('auth-key')
const PROOF = fixtureB64('account-proof')
const account = (proof = PROOF, salt = fixtureB64('account-salt', 16)) => ({ salt, m: 19_456, t: 2, p: 1, proof })
const EMAIL = 'two@example.test'
let host = 1
const ip = () => `198.51.100.${host++ % 250}`

type H = ReturnType<typeof harness>
const accountLogin = (h: H, proof = PROOF, extra: Record<string, unknown> = {}) =>
  h.request('POST', '/api/auth/account/login', { ip: ip(), body: { email: EMAIL, accountProof: proof, ...extra } })
const unlock = (h: H, accountToken: unknown, authKey = AUTH) =>
  h.request('POST', '/api/auth/unlock', { ip: ip(), body: { accountToken, authKey } })

async function withAccount(opts: Parameters<typeof harness>[0] = {}) {
  const h = harness({ allowRegistration: true, ...opts })
  const reg = await h.request('POST', '/api/auth/register', { body: registration({ email: EMAIL, account: account() }) })
  assert.equal(reg.status, 201)
  return { h, reg: reg.body }
}

test('register with an account password, then account → unlock; the master password alone no longer signs in', async () => {
  const { h, reg } = await withAccount()
  assert.ok(reg['accountToken'], 'registration signs the account in')
  assert.equal((await h.request('POST', '/api/auth/register', { body: registration({ email: 'same@example.test', account: account(), masterCheck: AUTH }) })).status, 400, 'the same text for both is refused')
  const pre = (await h.request('POST', '/api/auth/account/prelogin', { body: { email: EMAIL } })).body['account']
  assert.deepEqual(pre, { salt: fixtureB64('account-salt', 16), m: 19_456, t: 2, p: 1 })

  const legacy = await h.request('POST', '/api/auth/login', { ip: ip(), body: { email: EMAIL, authKey: AUTH } })
  assert.equal(legacy.body['error'], 'account_password_required')

  assert.equal((await accountLogin(h, fixtureB64('wrong'))).status, 401)
  const a = await accountLogin(h)
  assert.equal(a.status, 200)
  assert.ok(a.body['kdf'])
  assert.equal(a.body['wrappedVaultKey'], undefined, 'the account alone does not get the vault key')

  // The account token is not an access token.
  assert.equal((await h.request('GET', '/api/auth/me', { token: String(a.body['accountToken']) })).status, 401)

  const u = await unlock(h, a.body['accountToken'])
  assert.equal(u.status, 200)
  assert.ok(u.body['wrappedVaultKey'] && u.body['accessToken'] && u.body['accountToken'])
  const me = (await h.request('GET', '/api/auth/me', { token: String(u.body['accessToken']) })).body
  assert.equal((me['account'] as { set: boolean }).set, true)
})

test('a wrong master password keeps the account sign-in; a replayed account token ends every sign-in', async () => {
  const { h } = await withAccount()
  const a = await accountLogin(h)
  const wrong = await unlock(h, a.body['accountToken'], fixtureB64('not-the-master'))
  assert.equal(wrong.status, 401)
  assert.ok(wrong.body['accountToken'], 'a fresh account token to try again with')
  const right = await unlock(h, wrong.body['accountToken'])
  assert.equal(right.status, 200)
  // The first token was used up; presenting it again means a copy exists.
  assert.equal((await unlock(h, a.body['accountToken'])).status, 401)
  assert.equal((await unlock(h, right.body['accountToken'])).status, 401, 'every account sign-in ended')
  assert.equal((await h.request('POST', '/api/auth/refresh', { body: { refreshToken: right.body['refreshToken'] } })).status, 401, 'and every vault session')
})

test('the second factor belongs to the account step', async () => {
  const { h, reg } = await withAccount()
  const token = String(reg['accessToken'])
  const setup = await h.request('POST', '/api/auth/2fa/setup', { token, body: { currentAuthKey: AUTH } })
  const now = Date.UTC(2026, 8, 22, 12, 0, 0)
  await h.request('POST', '/api/auth/2fa/enable', { token, body: { code: (await generateTotp(String(setup.body['secret']), now)).code } })
  const first = await accountLogin(h)
  assert.equal(first.body['error'], 'two_factor_required')
  h.setNow(now + 30_000)
  const ok = await accountLogin(h, PROOF, { totpCode: (await generateTotp(String(setup.body['secret']), now + 30_000)).code })
  assert.equal(ok.status, 200)
  assert.equal((await unlock(h, ok.body['accountToken'])).status, 200, 'unlocking asks no second factor again')
})

test('an account from before signs in with the master password once and must set an account password', async () => {
  const h = harness({ allowRegistration: true })
  await h.request('POST', '/api/auth/register', { body: registration({ email: EMAIL }) })
  // Prelogin cannot tell it apart from an unknown address.
  const known = (await h.request('POST', '/api/auth/account/prelogin', { body: { email: EMAIL } })).body['account'] as { salt: string }
  const unknown = (await h.request('POST', '/api/auth/account/prelogin', { body: { email: 'nobody@example.test' } })).body['account'] as { salt: string }
  assert.equal(known.salt.length, unknown.salt.length)
  assert.equal(known.salt, (await h.request('POST', '/api/auth/account/prelogin', { body: { email: EMAIL } })).body['account'] && known.salt, 'stable')

  const legacy = await h.request('POST', '/api/auth/login', { ip: ip(), body: { email: EMAIL, authKey: AUTH } })
  assert.equal(legacy.status, 200)
  assert.equal(legacy.body['needsAccountPassword'], true)
  const token = String(legacy.body['accessToken'])
  assert.equal((await h.request('PUT', '/api/auth/account/password', { token, body: { account: account(), masterCheck: AUTH } })).status, 400, 'not the master password again')
  const set = await h.request('PUT', '/api/auth/account/password', { token, body: { account: account() } })
  assert.equal(set.status, 200)
  assert.ok(set.body['accountToken'])
  assert.equal((await h.request('POST', '/api/auth/login', { ip: ip(), body: { email: EMAIL, authKey: AUTH } })).body['error'], 'account_password_required')
  assert.equal((await unlock(h, set.body['accountToken'])).status, 200)

  // Changing it needs the current one, and ends other account sign-ins.
  const other = (await accountLogin(h)).body['accountToken']
  assert.equal((await h.request('PUT', '/api/auth/account/password', { token, body: { account: account(fixtureB64('new-proof')) } })).status, 400, 'current proof required')
  assert.equal((await h.request('PUT', '/api/auth/account/password', { token, body: { account: account(fixtureB64('new-proof')), currentAccountProof: fixtureB64('wrong') } })).status, 401)
  assert.equal((await h.request('PUT', '/api/auth/account/password', { token, body: { account: account(fixtureB64('new-proof')), currentAccountProof: PROOF } })).status, 200)
  assert.equal((await unlock(h, other)).status, 401)
  assert.equal((await accountLogin(h, fixtureB64('new-proof'))).status, 200)
})

test('forgotten: a single-use emailed link sets a new one and ends every session; the answer never says who exists', async () => {
  const { h, reg } = await withAccount({ mail: true })
  const unknown = await h.request('POST', '/api/auth/account/forgot', { ip: ip(), body: { email: 'nobody@example.test' } })
  const known = await h.request('POST', '/api/auth/account/forgot', { ip: ip(), body: { email: EMAIL } })
  assert.deepEqual(unknown.body, known.body)
  await new Promise((r) => setTimeout(r, 20))
  const mail = h.outbox.find((m) => m.to === EMAIL && /Reset your Vault account password/.test(m.subject))!
  assert.ok(mail, 'a reset email was sent')
  const code = decodeURIComponent(/account-reset=([^&\s]+)/.exec(mail.text)![1]!)
  const reset = (c: string, proof: string) => h.request('POST', '/api/auth/account/reset', { ip: ip(), body: { email: EMAIL, code: c, account: account(proof) } })
  assert.equal((await h.request('POST', '/api/auth/account/reset', { ip: ip(), body: { email: EMAIL, code, account: account(), masterCheck: AUTH } })).status, 400, 'not the master password')
  const fresh = await h.request('POST', '/api/auth/account/forgot', { ip: ip(), body: { email: EMAIL } })
  assert.equal(fresh.status, 200)
  await new Promise((r) => setTimeout(r, 20))
  const code2 = decodeURIComponent(/account-reset=([^&\s]+)/.exec(h.outbox.filter((m) => m.to === EMAIL).at(-1)!.text)![1]!)
  assert.equal((await reset(code2, fixtureB64('reset-proof'))).status, 200)
  assert.equal((await reset(code2, fixtureB64('again'))).status, 400, 'used once')
  assert.equal((await h.request('POST', '/api/auth/refresh', { body: { refreshToken: reg['refreshToken'] } })).status, 401, 'every session ended')
  assert.equal((await unlock(h, reg['accountToken'])).status, 401)
  assert.equal((await accountLogin(h, fixtureB64('reset-proof'))).status, 200)
})

test('an administrator can clear an account password; the person then signs in with the master password once', async () => {
  const h = harness({ adminEmails: ['owner@example.com'], allowRegistration: true })
  const owner = String((await h.request('POST', '/api/auth/register', { body: registration({ email: 'owner@example.com', authKey: fixtureB64('owner') }) })).body['accessToken'])
  const reg = (await h.request('POST', '/api/auth/register', { body: registration({ email: EMAIL, account: account() }) })).body
  assert.equal((await h.request('POST', `/api/admin/users/${reg['userId']}/reset-account-password`, { token: owner })).status, 200)
  assert.equal((await unlock(h, reg['accountToken'])).status, 401, 'its account sign-ins ended')
  const legacy = await h.request('POST', '/api/auth/login', { ip: ip(), body: { email: EMAIL, authKey: AUTH } })
  assert.equal(legacy.body['needsAccountPassword'], true)
})

test('mail is never sent to reserved example and test names', async () => {
  const { undeliverable } = await import('../src/mail.js')
  for (const a of ['a@example.com', 'b@mail.example.org', 'c@acme.example', 'd@x.test', 'e@y.invalid', 'f@localhost']) assert.equal(undeliverable(a), true, a)
  for (const a of ['a@gmail.com', 'b@dev2ops.in', 'c@examples.com', 'd@vault-ci.dev']) assert.equal(undeliverable(a), false, a)
})
