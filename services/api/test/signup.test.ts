// An account first, a vault later (decisions/0037): sign up with an emailed
// code, sign in to an account that has no vault, ask for one, an
// administrator approves, the person creates it. The address is the username.

import test from 'node:test'
import assert from 'node:assert/strict'

import { fixtureB64, harness, registration } from './harness.js'

const EMAIL = 'new@example.com'
const account = (proof = fixtureB64('acct-proof')) => ({ salt: fixtureB64('acct-salt', 16), m: 19_456, t: 2, p: 1, proof })
let n = 1
const ip = () => `198.51.100.${n++ % 250}`
type H = ReturnType<typeof harness>

const codeFrom = (h: H, to: string) => /\b(\d{6})\b/.exec(h.outbox.filter((m) => m.to === to && /sign-up code/.test(m.subject)).at(-1)!.text)![1]!

async function signUp(h: H, email = EMAIL) {
  assert.equal((await h.request('POST', '/api/auth/account/signup', { ip: ip(), body: { email } })).status, 200)
  await new Promise((r) => setTimeout(r, 10))
  const v = await h.request('POST', '/api/auth/account/signup/verify', { ip: ip(), body: { email, code: codeFrom(h, email), account: account() } })
  assert.equal(v.status, 201, JSON.stringify(v.body))
  return v.body
}

async function withOwner(registrationMode: 'open' | 'invite' | 'closed' = 'invite') {
  const h = harness({ adminEmails: ['owner@example.com'], allowRegistration: true, mail: true })
  const owner = String((await h.request('POST', '/api/auth/register', { body: registration({ email: 'owner@example.com', authKey: fixtureB64('owner') }) })).body['accessToken'])
  h.app.allowRegistration = false
  await h.request('PUT', '/api/admin/settings', { token: owner, body: { registration: registrationMode } })
  return { h, owner }
}

test('without mail there is no sign-up; with it, a code makes an account that has no vault', async () => {
  const plain = harness({ allowRegistration: true })
  assert.equal((await plain.request('POST', '/api/auth/account/signup', { body: { email: EMAIL } })).status, 503)

  const { h } = await withOwner('invite')
  await h.request('POST', '/api/auth/account/signup', { ip: ip(), body: { email: EMAIL } })
  await new Promise((r) => setTimeout(r, 10))
  const code = codeFrom(h, EMAIL)
  const bad = await h.request('POST', '/api/auth/account/signup/verify', { ip: ip(), body: { email: EMAIL, code: code === '000000' ? '111111' : '000000', account: account() } })
  assert.equal(bad.status, 400)
  const ok = await h.request('POST', '/api/auth/account/signup/verify', { ip: ip(), body: { email: EMAIL, code, account: account() } })
  assert.equal(ok.status, 201)
  assert.deepEqual([ok.body['vault'], ok.body['approved'], ok.body['requested'], ok.body['registration']], [false, false, false, 'invite'])
  assert.equal((await h.request('POST', '/api/auth/account/signup/verify', { ip: ip(), body: { email: EMAIL, code, account: account() } })).status, 400, 'the code works once')

  // Signing in to it: an account, no vault, nothing to unlock.
  const pre = (await h.request('POST', '/api/auth/account/prelogin', { body: { email: EMAIL } })).body['account'] as { salt: string }
  assert.equal(pre.salt, fixtureB64('acct-salt', 16))
  const login = await h.request('POST', '/api/auth/account/login', { ip: ip(), body: { email: EMAIL, accountProof: fixtureB64('acct-proof') } })
  assert.equal(login.status, 200)
  assert.deepEqual([login.body['kdf'], login.body['vault']], [null, false])
  assert.equal((await h.request('POST', '/api/auth/unlock', { ip: ip(), body: { accountToken: login.body['accountToken'], authKey: fixtureB64('x') } })).status, 409)
  assert.equal((await h.request('POST', '/api/auth/account/login', { ip: ip(), body: { email: EMAIL, accountProof: fixtureB64('wrong') } })).status, 401)
})

test('invitation only: ask for a vault; an administrator sees the address and approves; the person is emailed and creates it', async () => {
  const { h, owner } = await withOwner('invite')
  const acct = await signUp(h)
  const token = acct['accountToken']

  // Without approval or a code, no vault.
  assert.equal((await h.request('POST', '/api/auth/register', { body: registration({ email: EMAIL, accountToken: token }) })).status, 403)

  assert.equal((await h.request('POST', '/api/auth/vault/request', { body: { accountToken: token, note: 'Finance team' } })).status, 200)
  const list = (await h.request('GET', '/api/admin/vault-requests', { token: owner })).body['requests'] as { userId: string; email: string; note: string }[]
  assert.deepEqual(list.map((r) => [r.email, r.note]), [[EMAIL, 'Finance team']])
  assert.equal((await h.request('POST', `/api/admin/vault-requests/${list[0]!.userId}/approve`, { token: owner })).status, 200)
  await new Promise((r) => setTimeout(r, 10))
  assert.ok(h.outbox.some((m) => m.to === EMAIL && /ready to create/.test(m.subject)), 'the person is told')
  assert.equal(((await h.request('POST', '/api/auth/vault/status', { body: { accountToken: token } })).body['approved']), true)

  const created = await h.request('POST', '/api/auth/register', { body: registration({ email: EMAIL, accountToken: token }) })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  assert.equal(created.body['userId'], list[0]!.userId, 'the same account')
  assert.deepEqual((await h.request('GET', '/api/admin/vault-requests', { token: owner })).body['requests'], [])

  // Now a full account: account step, then the master password.
  const a = await h.request('POST', '/api/auth/account/login', { ip: ip(), body: { email: EMAIL, accountProof: fixtureB64('acct-proof') } })
  assert.equal(a.body['vault'], true)
  assert.equal((await h.request('POST', '/api/auth/unlock', { ip: ip(), body: { accountToken: a.body['accountToken'], authKey: fixtureB64('auth-key') } })).status, 200)
  const users = (await h.request('GET', '/api/admin/users', { token: owner })).body['users'] as { email: string | null }[]
  assert.ok(users.some((u) => u.email === EMAIL), 'the address is the username in the console')
})

test('open registration: the account creates its vault straight away; an address with an account is told by email', async () => {
  const { h } = await withOwner('open')
  const acct = await signUp(h, 'open@example.com')
  assert.equal(acct['registration'], 'open')
  assert.equal((await h.request('POST', '/api/auth/register', { body: registration({ email: 'open@example.com', accountToken: acct['accountToken'] }) })).status, 201)
  // The token is for one address only.
  const other = await signUp(h, 'other@example.com')
  assert.equal((await h.request('POST', '/api/auth/register', { body: registration({ email: 'someone@example.com', accountToken: other['accountToken'] }) })).status, 401)

  // Signing up again with an address that has an account: no code, a note instead.
  const before = h.outbox.length
  assert.equal((await h.request('POST', '/api/auth/account/signup', { ip: ip(), body: { email: 'open@example.com' } })).status, 200)
  await new Promise((r) => setTimeout(r, 10))
  const sent = h.outbox.slice(before)
  assert.deepEqual(sent.map((m) => m.subject), ['You already have a Vault account'])
})

test('a declined request is gone and approves nothing', async () => {
  const { h, owner } = await withOwner('invite')
  const acct = await signUp(h)
  await h.request('POST', '/api/auth/vault/request', { body: { accountToken: acct['accountToken'] } })
  const id = ((await h.request('GET', '/api/admin/vault-requests', { token: owner })).body['requests'] as { userId: string }[])[0]!.userId
  assert.equal((await h.request('POST', `/api/admin/vault-requests/${id}/decline`, { token: owner })).status, 200)
  const st = (await h.request('POST', '/api/auth/vault/status', { body: { accountToken: acct['accountToken'] } })).body
  assert.deepEqual([st['approved'], st['requested']], [false, false])
  assert.equal((await h.request('POST', '/api/auth/register', { body: registration({ email: EMAIL, accountToken: acct['accountToken'] }) })).status, 403)
})
