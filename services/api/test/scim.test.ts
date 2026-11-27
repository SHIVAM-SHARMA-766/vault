// Admin API tokens and SCIM 2.0 provisioning (admin console phase 5).

import test from 'node:test'
import assert from 'node:assert/strict'

import { dispatch } from '../src/app.js'
import { fixtureB64, harness, registration } from './harness.js'

const OWNER = 'owner@example.com'

async function setup() {
  const h = harness({ adminEmails: [OWNER], allowRegistration: true, mail: true })
  const owner = String((await h.request('POST', '/api/auth/register', { ip: '198.51.100.1', body: registration({ email: OWNER, authKey: fixtureB64('owner') }) })).body['accessToken'])
  const asha = String((await h.request('POST', '/api/auth/register', { ip: '198.51.100.2', body: registration({ email: 'asha@example.com', authKey: fixtureB64('asha') }) })).body['userId'])
  return { h, owner, asha }
}

async function makeToken(h: Awaited<ReturnType<typeof setup>>['h'], owner: string, scopes: string[]) {
  const res = await h.request('POST', '/api/admin/tokens', { token: owner, body: { name: 'Directory', scopes, days: 90 } })
  assert.equal(res.status, 201, JSON.stringify(res.body))
  return String(res.body['token'])
}

/** A request with a raw Authorization header (SCIM clients send that one). */
async function call(h: Awaited<ReturnType<typeof setup>>['h'], method: string, path: string, token: string, body?: unknown) {
  const [rawPath, rawQueryString] = path.split('?') as [string, string | undefined]
  const res = await dispatch(h.app, {
    rawPath, ...(rawQueryString ? { rawQueryString } : {}),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/scim+json' },
    requestContext: { http: { method, sourceIp: '203.0.113.50' } },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.statusCode, type: String(res.headers?.['content-type'] ?? ''), body: res.body ? JSON.parse(res.body) as Record<string, unknown> : {} }
}

test('an API token works only within its scopes, shows once, and can be revoked', async () => {
  const { h, owner } = await setup()
  const token = await makeToken(h, owner, ['users.read'])
  assert.match(token, /^vault_pat_[A-Za-z0-9]{12}\.[A-Za-z0-9_-]{43}$/)
  const list = (await h.request('GET', '/api/admin/tokens', { token: owner })).body
  assert.ok(!JSON.stringify(list).includes(token.split('.')[1]!), 'the secret is never listed')

  assert.equal((await call(h, 'GET', '/api/admin/users', token)).status, 200)
  assert.equal((await call(h, 'GET', '/api/admin/audit', token)).status, 403, 'no audit.read scope')
  assert.equal((await call(h, 'GET', '/api/admin/tokens', token)).status, 403, 'a token never manages tokens')
  assert.equal((await call(h, 'GET', '/api/admin/users', `${token.slice(0, -2)}xx`)).status, 401, 'a wrong secret')
  assert.equal((await h.request('POST', '/api/admin/tokens', { token: owner, body: { name: 'x', scopes: ['roles.write'] } })).status, 400, 'roles.write is not a scope')

  const id = (list['tokens'] as { id: string }[])[0]!.id
  assert.equal((await h.request('DELETE', `/api/admin/tokens/${id}`, { token: owner })).status, 200)
  assert.equal((await call(h, 'GET', '/api/admin/users', token)).status, 401)
  const audit = (await h.request('GET', '/api/admin/audit?action=token.', { token: owner })).body['records'] as { action: string }[]
  assert.deepEqual(audit.map((r) => r.action).sort(), ['token.create', 'token.revoke'])
})

test('SCIM: users are listed and filtered; a new one is an emailed invitation', async () => {
  const { h, owner } = await setup()
  const token = await makeToken(h, owner, ['scim'])
  assert.equal((await call(h, 'GET', '/api/admin/users', token)).status, 403, 'scim scope alone is not the admin API')

  const config = await call(h, 'GET', '/api/scim/v2/ServiceProviderConfig', token)
  assert.equal(config.status, 200)
  assert.match(config.type, /application\/scim\+json/)
  const all = await call(h, 'GET', '/api/scim/v2/Users', token)
  assert.equal(all.body['totalResults'], 2)
  const one = await call(h, 'GET', `/api/scim/v2/Users?filter=${encodeURIComponent('userName eq "ASHA@example.com"')}`, token)
  assert.deepEqual((one.body['Resources'] as { userName: string; active: boolean }[]).map((r) => [r.userName, r.active]), [['asha@example.com', true]])
  assert.equal((await call(h, 'GET', `/api/scim/v2/Users?filter=${encodeURIComponent('name.givenName sw "a"')}`, token)).body['scimType'], 'invalidFilter')

  const created = await call(h, 'POST', '/api/scim/v2/Users', token, { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'new.person@example.com', externalId: 'ext-1', active: true })
  assert.equal(created.status, 201)
  assert.match(String(created.body['id']), /^inv_/)
  await new Promise((r) => setTimeout(r, 10))
  assert.ok(h.outbox.some((m) => m.to === 'new.person@example.com'), 'the invitation is emailed')
  assert.equal((await call(h, 'POST', '/api/scim/v2/Users', token, { userName: 'asha@example.com' })).body['scimType'], 'uniqueness')
  const byExt = await call(h, 'GET', `/api/scim/v2/Users?filter=${encodeURIComponent('externalId eq "ext-1"')}`, token)
  assert.equal(byExt.body['totalResults'], 1)
})

test('SCIM: deactivating disables and signs out; deleting offboards and keeps the vault', async () => {
  const { h, owner, asha } = await setup()
  const token = await makeToken(h, owner, ['scim'])
  const ashaToken = String((await h.request('POST', '/api/auth/login', { ip: '198.51.100.9', body: { email: 'asha@example.com', authKey: fixtureB64('asha') } })).body['accessToken'])
  // Entra ID sends "False" as a string.
  const off = await call(h, 'PATCH', `/api/scim/v2/Users/${asha}`, token, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'Replace', path: 'active', value: 'False' }] })
  assert.equal(off.status, 200)
  assert.equal(off.body['active'], false)
  assert.equal((await h.request('GET', '/api/vault', { token: ashaToken })).status, 401, 'signed out everywhere')
  const on = await call(h, 'PATCH', `/api/scim/v2/Users/${asha}`, token, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', value: { active: true } }] })
  assert.equal(on.body['active'], true)

  assert.equal((await call(h, 'DELETE', `/api/scim/v2/Users/${asha}`, token)).status, 204)
  assert.ok(await h.app.store.get(`USER#${asha}`, 'PROFILE'), 'the vault is kept')
  assert.equal(((await call(h, 'GET', `/api/scim/v2/Users/${asha}`, token)).body as { active: boolean }).active, false)

  // An invitation not yet used: deleting withdraws it.
  const inv = await call(h, 'POST', '/api/scim/v2/Users', token, { userName: 'later@example.com' })
  assert.equal((await call(h, 'DELETE', `/api/scim/v2/Users/${String(inv.body['id'])}`, token)).status, 204)
  assert.equal((await call(h, 'GET', `/api/scim/v2/Users/${String(inv.body['id'])}`, token)).status, 404)
  const actions = ((await h.request('GET', '/api/admin/audit', { token: owner })).body['records'] as { action: string; actorLabel: string | null }[])
  assert.ok(actions.some((r) => r.action === 'user.offboard' && r.actorLabel === 'API token "Directory"'), 'the token is named in the audit log')
})
