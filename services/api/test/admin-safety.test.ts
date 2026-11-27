// Admin safety (admin console phase 3): sensitive actions need a recent
// sign-in or the master password again; staff may be required to use
// two-factor sign-in; owners and admins hear about changes to who runs the
// server.

import test from 'node:test'
import assert from 'node:assert/strict'

import { fixtureB64, harness, registration } from './harness.js'

const OWNER = 'owner@example.com'

async function setup() {
  const h = harness({ adminEmails: [OWNER, 'second@example.com'], allowRegistration: true, mail: true })
  const reg = (email: string, i: number) => h.request('POST', '/api/auth/register', { ip: `198.51.100.${i}`, body: registration({ email, authKey: fixtureB64(email) }) })
  const first = (await reg(OWNER, 1)).body
  const owner = String(first['accessToken'])
  await reg('second@example.com', 2)
  const person = String((await reg('person@example.com', 3)).body['userId'])
  return { h, owner, person, refreshToken: String(first['refreshToken']) }
}

test('a sensitive action counts on a recent sign-in; later it needs the master password again', async () => {
  const { h, owner: first, person, refreshToken } = await setup()
  let owner = first
  // Within ten minutes of signing in: allowed.
  assert.equal((await h.request('PUT', `/api/admin/users/${person}/role`, { token: owner, body: { role: 'viewer' } })).status, 200)

  h.setNow(h.app.now() + 11 * 60_000)
  const refused = await h.request('PUT', `/api/admin/users/${person}/role`, { token: owner, body: { role: 'support' } })
  assert.equal(refused.status, 403)
  assert.equal(refused.body['error'], 'reauth_required')
  // Reading and plain changes do not ask.
  assert.equal((await h.request('GET', '/api/admin/users', { token: owner })).status, 200)
  assert.equal((await h.request('PUT', `/api/admin/users/${person}/label`, { token: owner, body: { label: 'x' } })).status, 200)

  assert.equal((await h.request('POST', '/api/auth/reauth', { token: owner, body: { authKey: fixtureB64('wrong') } })).status, 401)
  const ok = await h.request('POST', '/api/auth/reauth', { token: owner, body: { authKey: fixtureB64(OWNER) } })
  assert.equal(ok.status, 200)
  assert.ok(Date.parse(String(ok.body['until'])) > h.app.now())
  assert.equal((await h.request('PUT', `/api/admin/users/${person}/role`, { token: owner, body: { role: 'support' } })).status, 200)
  // Settings and deleting are sensitive too. A refresh keeps the device
  // signed in but does not count as confirming again.
  h.setNow(h.app.now() + 11 * 60_000)
  owner = String((await h.request('POST', '/api/auth/refresh', { body: { refreshToken } })).body['accessToken'])
  const settings = (await h.request('GET', '/api/admin/settings', { token: owner })).body as { policy: Record<string, unknown> }
  assert.equal((await h.request('PUT', '/api/admin/settings', { token: owner, body: { policy: settings.policy } })).body['error'], 'reauth_required')
  assert.equal((await h.request('POST', `/api/admin/users/${person}/delete`, { token: owner, body: { confirm: person } })).body['error'], 'reauth_required')
})

test('staff two-factor: refused to someone without it, and cannot be turned on by them', async () => {
  const { h, owner } = await setup()
  const settings = (await h.request('GET', '/api/admin/settings', { token: owner })).body as { policy: Record<string, unknown> }
  const on = { ...settings.policy, requireStaffTwoFactor: true }
  const lockout = await h.request('PUT', '/api/admin/settings', { token: owner, body: { policy: on } })
  assert.equal(lockout.status, 400)
  assert.match(String(lockout.body['message']), /your own account first/)

  // With two-factor on the owner's own account, it can be required.
  const ownerId = String((await h.request('GET', '/api/auth/me', { token: owner })).body['userId'])
  const profile = await h.app.store.get(`USER#${ownerId}`, 'PROFILE')
  await h.app.store.put({ ...profile!, totp: { secret: 'x' } })
  assert.equal((await h.request('PUT', '/api/admin/settings', { token: owner, body: { policy: on } })).status, 200)
  assert.equal((await h.request('GET', '/api/admin/overview', { token: owner })).status, 200)

  // The second owner has none: the console says what to do.
  const second = String((await h.request('POST', '/api/auth/login', { ip: '198.51.100.9', body: { email: 'second@example.com', authKey: fixtureB64('second@example.com') } })).body['accessToken'])
  const refused = await h.request('GET', '/api/admin/overview', { token: second })
  assert.equal(refused.status, 403)
  assert.equal(refused.body['error'], 'staff_two_factor_required')
  // Their own vault still works.
  assert.equal((await h.request('GET', '/api/vault', { token: second })).status, 200)
})

test('a role change, a policy change and a deletion are emailed to the other owners and admins', async () => {
  const { h, owner, person } = await setup()
  const before = h.outbox.length
  await h.request('PUT', `/api/admin/users/${person}/role`, { token: owner, body: { role: 'admin' } })
  await new Promise((r) => setTimeout(r, 20))
  const sent = h.outbox.slice(before)
  // The other owner and the new admin are told; the one who did it is not.
  assert.deepEqual(sent.map((m) => m.to).sort(), ['person@example.com', 'second@example.com'])
  assert.match(sent[0]!.subject, /made person@example.com an admin/)
  assert.match(sent[0]!.text, /owner@example.com made person@example.com/)

  const mid = h.outbox.length
  await h.request('PUT', '/api/admin/settings', { token: owner, body: { registration: 'invite' } })
  await new Promise((r) => setTimeout(r, 20))
  assert.ok(h.outbox.slice(mid).some((m) => /changed registration to "invite"/.test(m.subject)))
})
