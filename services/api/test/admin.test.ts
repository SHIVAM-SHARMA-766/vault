// The operator's routes: who can reach them, what they can change, and that
// none of it exposes vault content or addresses.

import test from 'node:test'
import assert from 'node:assert/strict'

import { fixtureB64, harness, registration, sealedBlob } from './harness.js'

const ADMIN = 'owner@example.com'

async function setup(options: { allowRegistration?: boolean } = {}) {
  const h = harness({ adminEmails: [ADMIN], allowRegistration: true })
  const owner = await h.request('POST', '/api/auth/register', {
    body: registration({ email: ADMIN, authKey: fixtureB64('owner-auth') }),
  })
  const user = await h.request('POST', '/api/auth/register', {
    body: registration({ email: 'someone@example.com', authKey: fixtureB64('user-auth') }),
  })
  h.app.allowRegistration = options.allowRegistration ?? false
  return {
    h,
    ownerToken: String(owner.body['accessToken']),
    ownerId: String(owner.body['userId']),
    userToken: String(user.body['accessToken']),
    userId: String(user.body['userId']),
  }
}

test('a normal account cannot reach the admin routes', async () => {
  const { h, userToken } = await setup()
  for (const [method, path] of [['GET', '/api/admin/overview'], ['GET', '/api/admin/users'], ['PUT', '/api/admin/settings']] as const) {
    const res = await h.request(method, path, { token: userToken, body: { registration: 'open' } })
    assert.equal(res.status, 403, `${method} ${path}`)
  }
})

test('the admin routes need a session at all', async () => {
  const { h } = await setup()
  assert.equal((await h.request('GET', '/api/admin/overview')).status, 401)
})

test('me says whether the account is an admin', async () => {
  const { h, ownerToken, userToken } = await setup()
  assert.equal((await h.request('GET', '/api/auth/me', { token: ownerToken })).body['isAdmin'], true)
  assert.equal((await h.request('GET', '/api/auth/me', { token: userToken })).body['isAdmin'], false)
})

test('the user list carries counts, never addresses or content', async () => {
  const { h, ownerToken, userToken } = await setup()
  await h.request('PUT', '/api/vault/entries/entry-0001', { token: userToken, body: { blob: sealedBlob('e1') } })
  const res = await h.request('GET', '/api/admin/users', { token: ownerToken })
  assert.equal(res.status, 200)
  const users = res.body['users'] as Array<Record<string, unknown>>
  assert.equal(users.length, 2)
  const someone = users.find((u) => u['isAdmin'] === false)!
  assert.equal(someone['entries'], 1)
  const text = JSON.stringify(res.body)
  assert.ok(!text.includes('someone@example.com'))
  assert.ok(!text.includes('emailDigest'))
  assert.ok(!text.includes(sealedBlob('e1')))
})

test('registration is closed by default and the admin can open it', async () => {
  const { h, ownerToken } = await setup()
  const refused = await h.request('POST', '/api/auth/register', { body: registration({ email: 'new@example.com' }) })
  assert.equal(refused.status, 403)

  assert.equal((await h.request('PUT', '/api/admin/settings', { token: ownerToken, body: { registration: 'open' } })).status, 200)
  const allowed = await h.request('POST', '/api/auth/register', { body: registration({ email: 'new@example.com' }) })
  assert.equal(allowed.status, 201)
})

test('an unknown registration mode is refused', async () => {
  const { h, ownerToken } = await setup()
  const res = await h.request('PUT', '/api/admin/settings', { token: ownerToken, body: { registration: 'everyone' } })
  assert.equal(res.status, 400)
})

test('an invitation admits exactly one registration, and labels the account', async () => {
  const { h, ownerToken } = await setup()
  await h.request('PUT', '/api/admin/settings', { token: ownerToken, body: { registration: 'invite' } })

  const created = await h.request('POST', '/api/admin/invites', { token: ownerToken, body: { label: 'For Rahul', days: 3 } })
  assert.equal(created.status, 201)
  const code = String(created.body['code'])
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){5}$/)

  const noCode = await h.request('POST', '/api/auth/register', { body: registration({ email: 'rahul@example.com' }) })
  assert.equal(noCode.status, 403)

  const first = await h.request('POST', '/api/auth/register', { body: registration({ email: 'rahul@example.com', inviteCode: code }) })
  assert.equal(first.status, 201)

  const again = await h.request('POST', '/api/auth/register', { body: registration({ email: 'other@example.com', inviteCode: code }) })
  assert.equal(again.status, 403)

  const users = (await h.request('GET', '/api/admin/users', { token: ownerToken })).body['users'] as Array<Record<string, unknown>>
  assert.ok(users.some((u) => u['label'] === 'For Rahul'))

  const invites = (await h.request('GET', '/api/admin/invites', { token: ownerToken })).body['invites'] as Array<Record<string, unknown>>
  assert.equal(invites[0]!['status'], 'used')
})

test('only the hash of an invitation code is stored', async () => {
  const { h, ownerToken } = await setup()
  const created = await h.request('POST', '/api/admin/invites', { token: ownerToken, body: { label: 'x' } })
  assert.ok(!JSON.stringify(h.store.dump()).includes(String(created.body['code'])))
})

test('an expired invitation is refused', async () => {
  const { h, ownerToken } = await setup()
  await h.request('PUT', '/api/admin/settings', { token: ownerToken, body: { registration: 'invite' } })
  const created = await h.request('POST', '/api/admin/invites', { token: ownerToken, body: { label: 'late', days: 1 } })
  h.setNow(Date.UTC(2026, 8, 24, 12, 0, 0))
  const res = await h.request('POST', '/api/auth/register', {
    body: registration({ email: 'late@example.com', inviteCode: String(created.body['code']) }),
  })
  assert.equal(res.status, 403)
})

test('a disabled account cannot sign in or refresh, and its sessions are gone', async () => {
  const { h, ownerToken, userId } = await setup()
  const login = await h.request('POST', '/api/auth/login', {
    body: { email: 'someone@example.com', authKey: fixtureB64('user-auth') },
  })
  const refreshToken = String(login.body['refreshToken'])

  assert.equal((await h.request('PUT', `/api/admin/users/${userId}/disabled`, { token: ownerToken, body: { disabled: true } })).status, 200)

  const again = await h.request('POST', '/api/auth/login', {
    body: { email: 'someone@example.com', authKey: fixtureB64('user-auth') },
  })
  assert.equal(again.status, 403)
  assert.equal((await h.request('POST', '/api/auth/refresh', { body: { refreshToken } })).status, 401)

  await h.request('PUT', `/api/admin/users/${userId}/disabled`, { token: ownerToken, body: { disabled: false } })
  const back = await h.request('POST', '/api/auth/login', {
    body: { email: 'someone@example.com', authKey: fixtureB64('user-auth') },
  })
  assert.equal(back.status, 200)
})

test('a wrong password on a disabled account still reads as a wrong password', async () => {
  const { h, ownerToken, userId } = await setup()
  await h.request('PUT', `/api/admin/users/${userId}/disabled`, { token: ownerToken, body: { disabled: true } })
  const res = await h.request('POST', '/api/auth/login', {
    body: { email: 'someone@example.com', authKey: fixtureB64('not-the-key') },
  })
  assert.equal(res.status, 401)
})

test('the admin cannot disable or delete their own account', async () => {
  const { h, ownerToken, ownerId } = await setup()
  assert.equal((await h.request('PUT', `/api/admin/users/${ownerId}/disabled`, { token: ownerToken, body: { disabled: true } })).status, 400)
  assert.equal((await h.request('POST', `/api/admin/users/${ownerId}/delete`, { token: ownerToken, body: { confirm: ownerId } })).status, 400)
})

test('deleting an account removes everything it held and frees the address', async () => {
  const { h, ownerToken, userId, userToken } = await setup()
  await h.request('PUT', '/api/vault/entries/entry-0001', { token: userToken, body: { blob: sealedBlob('e1') } })

  const unconfirmed = await h.request('POST', `/api/admin/users/${userId}/delete`, { token: ownerToken, body: {} })
  assert.equal(unconfirmed.status, 400)

  assert.equal((await h.request('POST', `/api/admin/users/${userId}/delete`, { token: ownerToken, body: { confirm: userId } })).status, 200)
  assert.ok(!h.store.dump().some((i) => i.pk === `USER#${userId}` || i.sk === `USER#${userId}`))

  h.app.allowRegistration = true
  const reuse = await h.request('POST', '/api/auth/register', { body: registration({ email: 'someone@example.com' }) })
  assert.equal(reuse.status, 201)
})

test('every admin action lands in the audit log', async () => {
  const { h, ownerToken, ownerId, userId } = await setup()
  await h.request('PUT', '/api/admin/settings', { token: ownerToken, body: { registration: 'invite' } })
  await h.request('POST', `/api/admin/users/${userId}/revoke-sessions`, { token: ownerToken })
  const res = await h.request('GET', '/api/admin/audit', { token: ownerToken })
  const actions = (res.body['records'] as Array<Record<string, unknown>>).map((r) => r['action'])
  assert.deepEqual(actions.sort(), ['settings.registration', 'user.revoke-sessions'])
  assert.ok((res.body['records'] as Array<Record<string, unknown>>).every((r) => r['actor'] === ownerId))
})

test('the overview reports the last backup the host recorded', async () => {
  const { h, ownerToken } = await setup()
  await h.store.put({ pk: 'SYSTEM', sk: 'BACKUP', at: '2026-09-22T00:30:00Z', object: 'vault-x.sql.gz', bytes: 1500 })
  const res = await h.request('GET', '/api/admin/overview', { token: ownerToken })
  assert.equal(res.status, 200)
  assert.equal(res.body['users'], 2)
  assert.deepEqual(res.body['lastBackup'], { at: '2026-09-22T00:30:00Z', object: 'vault-x.sql.gz', bytes: 1500 })
})
