// Staff roles: what each can reach, and who can grant them.

import test from 'node:test'
import assert from 'node:assert/strict'

import { fixtureB64, harness, registration } from './harness.js'

const OWNER = 'owner@example.com'

async function team() {
  const h = harness({ adminEmails: [OWNER], allowRegistration: true })
  const reg = async (email: string) => {
    const r = await h.request('POST', '/api/auth/register', { body: registration({ email, authKey: fixtureB64(email) }) })
    return { id: String(r.body['userId']), token: String(r.body['accessToken']) }
  }
  const owner = await reg(OWNER)
  const admin = await reg('admin@example.com')
  const marketing = await reg('marketing@example.com')
  const viewer = await reg('viewer@example.com')
  const user = await reg('user@example.com')
  for (const [who, role] of [[admin, 'admin'], [marketing, 'marketing'], [viewer, 'viewer']] as const) {
    const res = await h.request('PUT', `/api/admin/users/${who.id}/role`, { token: owner.token, body: { role } })
    assert.equal(res.status, 200)
  }
  h.app.allowRegistration = false
  return { h, owner, admin, marketing, viewer, user }
}

test('me reports each role and its permissions', async () => {
  const { h, owner, marketing, viewer, user } = await team()
  const me = async (t: string) => (await h.request('GET', '/api/auth/me', { token: t })).body
  assert.equal((await me(owner.token))['role'], 'owner')
  assert.equal((await me(marketing.token))['role'], 'marketing')
  assert.deepEqual((await me(marketing.token))['permissions'], ['site.read', 'site.write', 'site.publish'])
  assert.equal((await me(viewer.token))['isAdmin'], true)
  assert.equal((await me(user.token))['isAdmin'], false)
})

test('each role reaches exactly what it should', async () => {
  const { h, owner, admin, marketing, viewer, user } = await team()
  const cases: Array<[string, string, string, unknown?]> = [
    ['GET', '/api/admin/overview', 'overview'],
    ['GET', '/api/admin/users', 'users'],
    ['GET', '/api/admin/audit', 'audit'],
    ['PUT', '/api/admin/settings', 'settings', { registration: 'invite' }],
    ['POST', '/api/admin/invites', 'invite', { label: 'x' }],
  ]
  const expected: Record<string, Record<string, number>> = {
    owner: { overview: 200, users: 200, audit: 200, settings: 200, invite: 201 },
    admin: { overview: 200, users: 200, audit: 200, settings: 200, invite: 201 },
    marketing: { overview: 403, users: 403, audit: 403, settings: 403, invite: 403 },
    viewer: { overview: 200, users: 200, audit: 200, settings: 403, invite: 403 },
    user: { overview: 403, users: 403, audit: 403, settings: 403, invite: 403 },
  }
  for (const [name, who] of Object.entries({ owner, admin, marketing, viewer, user })) {
    for (const [method, path, key, body] of cases) {
      const res = await h.request(method, path, { token: who.token, ...(body ? { body } : {}) })
      assert.equal(res.status, expected[name]![key], `${name} ${method} ${path}`)
    }
  }
})

test('only the owner grants roles, and nobody can grant owner', async () => {
  const { h, owner, admin, user } = await team()
  assert.equal((await h.request('PUT', `/api/admin/users/${user.id}/role`, { token: admin.token, body: { role: 'viewer' } })).status, 403)
  assert.equal((await h.request('PUT', `/api/admin/users/${user.id}/role`, { token: owner.token, body: { role: 'owner' } })).status, 400)
  assert.equal((await h.request('PUT', `/api/admin/users/${owner.id}/role`, { token: owner.token, body: { role: 'user' } })).status, 400)
})

test('an admin cannot act on another admin or the owner', async () => {
  const { h, owner, admin, marketing } = await team()
  const other = (await h.request('GET', '/api/admin/users', { token: owner.token })).body['users'] as Array<Record<string, unknown>>
  assert.ok(other.length >= 5)
  assert.equal((await h.request('PUT', `/api/admin/users/${owner.id}/disabled`, { token: admin.token, body: { disabled: true } })).status, 403)
  assert.equal((await h.request('POST', `/api/admin/users/${owner.id}/revoke-sessions`, { token: admin.token })).status, 403)
  // but can manage the roles beneath it
  assert.equal((await h.request('PUT', `/api/admin/users/${marketing.id}/disabled`, { token: admin.token, body: { disabled: true } })).status, 200)
})

test('an invitation can carry a role, but only the owner can issue one', async () => {
  const { h, owner, admin } = await team()
  await h.request('PUT', '/api/admin/settings', { token: owner.token, body: { registration: 'invite' } })
  assert.equal((await h.request('POST', '/api/admin/invites', { token: admin.token, body: { label: 'seo', role: 'marketing' } })).status, 403)
  const inv = await h.request('POST', '/api/admin/invites', { token: owner.token, body: { label: 'SEO agency', role: 'marketing' } })
  assert.equal(inv.status, 201)
  const reg = await h.request('POST', '/api/auth/register', {
    body: registration({ email: 'agency@example.com', authKey: fixtureB64('agency'), inviteCode: inv.body['code'] }),
  })
  assert.equal(reg.status, 201)
  const me = await h.request('GET', '/api/auth/me', { token: String(reg.body['accessToken']) })
  assert.equal(me.body['role'], 'marketing')
})

test('a revoked role takes effect on the next request', async () => {
  const { h, owner, viewer } = await team()
  assert.equal((await h.request('GET', '/api/admin/overview', { token: viewer.token })).status, 200)
  await h.request('PUT', `/api/admin/users/${viewer.id}/role`, { token: owner.token, body: { role: 'user' } })
  assert.equal((await h.request('GET', '/api/admin/overview', { token: viewer.token })).status, 403)
})
