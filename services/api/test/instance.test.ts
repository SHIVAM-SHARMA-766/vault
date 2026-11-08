// The instance profile: the server's name and support contact, set by an
// admin, shown to anyone, and carried on every email.

import test from 'node:test'
import assert from 'node:assert/strict'

import { fixtureB64, harness, registration } from './harness.js'

async function setup() {
  const h = harness({ adminEmails: ['owner@example.com'], allowRegistration: true, mail: true })
  const owner = await h.request('POST', '/api/auth/register', { body: registration({ email: 'owner@example.com', authKey: fixtureB64('owner') }) })
  const user = await h.request('POST', '/api/auth/register', { body: registration({ email: 'user@example.com', authKey: fixtureB64('user') }) })
  h.app.allowRegistration = false
  return { h, owner: String(owner.body['accessToken']), user: String(user.body['accessToken']) }
}

const PROFILE = { name: 'Acme Vault', supportEmail: 'help@acme.example', supportUrl: 'https://acme.example/help' }

test('with nothing set, the instance calls itself Vault and has no contact', async () => {
  const { h } = await setup()
  const res = await h.request('GET', '/api/instance')
  assert.equal(res.status, 200)
  assert.equal(res.body['name'], 'Vault')
  assert.equal(res.body['supportEmail'], '')
  assert.equal(res.body['registration'], 'closed')
  assert.equal(res.body['mail'], true)
})

test('an admin sets the profile; anyone can read it without signing in', async () => {
  const { h, owner } = await setup()
  assert.equal((await h.request('PUT', '/api/admin/settings', { token: owner, body: { profile: PROFILE } })).status, 200)
  const res = await h.request('GET', '/api/instance')
  assert.equal(res.body['name'], 'Acme Vault')
  assert.equal(res.body['supportEmail'], 'help@acme.example')
  assert.equal(res.body['supportUrl'], 'https://acme.example/help')
  const settings = await h.request('GET', '/api/admin/settings', { token: owner })
  assert.deepEqual(settings.body['profile'], { ...PROFILE, accent: '', logo: '' })
})

test('changing the profile leaves registration alone, and the other way round', async () => {
  const { h, owner } = await setup()
  await h.request('PUT', '/api/admin/settings', { token: owner, body: { registration: 'invite' } })
  await h.request('PUT', '/api/admin/settings', { token: owner, body: { profile: PROFILE } })
  assert.equal((await h.request('GET', '/api/instance')).body['registration'], 'invite')
  await h.request('PUT', '/api/admin/settings', { token: owner, body: { registration: 'closed' } })
  assert.equal((await h.request('GET', '/api/instance')).body['name'], 'Acme Vault')
})

test('a member cannot change the profile', async () => {
  const { h, user } = await setup()
  assert.equal((await h.request('PUT', '/api/admin/settings', { token: user, body: { profile: PROFILE } })).status, 403)
})

test('bad profile values are refused', async () => {
  const { h, owner } = await setup()
  const bad = [
    { ...PROFILE, supportEmail: 'not an address' },
    { ...PROFILE, supportUrl: 'javascript:alert(1)' },
    { ...PROFILE, supportUrl: 'ftp://acme.example' },
    { ...PROFILE, name: 'x'.repeat(61) },
    { ...PROFILE, name: '<script>' },
    { ...PROFILE, name: 42 },
    'a string',
  ]
  for (const profile of bad) {
    const res = await h.request('PUT', '/api/admin/settings', { token: owner, body: { profile } })
    assert.equal(res.status, 400, JSON.stringify(profile))
  }
  assert.equal((await h.request('PUT', '/api/admin/settings', { token: owner, body: {} })).status, 400)
  assert.equal((await h.request('GET', '/api/instance')).body['name'], 'Vault')
})

test('empty fields clear the profile', async () => {
  const { h, owner } = await setup()
  await h.request('PUT', '/api/admin/settings', { token: owner, body: { profile: PROFILE } })
  await h.request('PUT', '/api/admin/settings', { token: owner, body: { profile: { name: '', supportEmail: '', supportUrl: '' } } })
  const res = await h.request('GET', '/api/instance')
  assert.equal(res.body['name'], 'Vault')
  assert.equal(res.body['supportEmail'], '')
})

test('the change is audited', async () => {
  const { h, owner } = await setup()
  await h.request('PUT', '/api/admin/settings', { token: owner, body: { profile: PROFILE } })
  const audit = (await h.request('GET', '/api/admin/audit', { token: owner })).body['records'] as Array<Record<string, unknown>>
  assert.ok(audit.some((r) => r['action'] === 'settings.profile'))
})

test('email replies go to the support address, and the message says how to get help', async () => {
  const { h, owner } = await setup()
  await h.request('PUT', '/api/admin/settings', { token: owner, body: { profile: PROFILE } })
  await h.request('POST', '/api/admin/invites', { token: owner, body: { email: 'new@example.com', label: 'New' } })
  const sent = h.outbox.at(-1)!
  assert.equal(sent.replyTo, 'help@acme.example')
  assert.match(sent.text, /Need help\? help@acme\.example · https:\/\/acme\.example\/help/)
})

test('with no support address, email has no Reply-To and no help line', async () => {
  const { h, owner } = await setup()
  await h.request('POST', '/api/admin/invites', { token: owner, body: { email: 'new@example.com', label: 'New' } })
  const sent = h.outbox.at(-1)!
  assert.equal(sent.replyTo, undefined)
  assert.doesNotMatch(sent.text, /Need help/)
})

test('a new server says it is waiting for its owner, and stops once anyone exists', async () => {
  const h = harness({ allowRegistration: false })
  assert.equal((await h.request('GET', '/api/instance')).body['firstRun'], true)
  const { h: h2 } = await setup()
  assert.equal((await h2.request('GET', '/api/instance')).body['firstRun'], false)
})
