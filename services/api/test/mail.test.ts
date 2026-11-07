// Mail: sign-in and recovery notices, invitations by email, the test route,
// and that a failing mail server never fails the request that triggered it.

import test from 'node:test'
import assert from 'node:assert/strict'

import { fixtureB64, harness, registration } from './harness.js'

test('a sign-in sends a notice to the address that signed in, with the device', async () => {
  const h = harness({ mail: true })
  const reg = registration({ email: 'ana@example.test' })
  await h.request('POST', '/api/auth/register', { body: reg })
  assert.equal(h.outbox.length, 0, 'registering sends nothing')
  await h.request('POST', '/api/auth/login', { ip: '198.51.100.4', body: { email: 'ana@example.test', authKey: fixtureB64('auth-key') } })
  await new Promise((r) => setImmediate(r))
  assert.equal(h.outbox.length, 1)
  assert.equal(h.outbox[0]!.to, 'ana@example.test')
  assert.match(h.outbox[0]!.subject, /New sign-in/)
  assert.match(h.outbox[0]!.text, /198\.51\.100\.4/)
})

test('a failed sign-in sends nothing, and notices can be turned off', async () => {
  const h = harness({ mail: true })
  await h.request('POST', '/api/auth/register', { body: registration({ email: 'bo@example.test' }) })
  await h.request('POST', '/api/auth/login', { body: { email: 'bo@example.test', authKey: fixtureB64('wrong') } })
  h.app.config.mail.signInNotices = false
  await h.request('POST', '/api/auth/login', { body: { email: 'bo@example.test', authKey: fixtureB64('auth-key') } })
  await new Promise((r) => setImmediate(r))
  assert.equal(h.outbox.length, 0)
})

test('a broken mail server does not fail the sign-in', async () => {
  const h = harness({ mail: true })
  h.app.mailer = { send: async () => { throw new Error('connection refused') } }
  await h.request('POST', '/api/auth/register', { body: registration({ email: 'cy@example.test' }) })
  const res = await h.request('POST', '/api/auth/login', { body: { email: 'cy@example.test', authKey: fixtureB64('auth-key') } })
  assert.equal(res.status, 200)
})

async function owner(h: ReturnType<typeof harness>) {
  const { emailDigest } = await import('../src/identity.js')
  h.app.adminDigests = new Set([emailDigest('boss@example.test', h.app.config.pepper)])
  const res = await h.request('POST', '/api/auth/register', { body: registration({ email: 'boss@example.test' }) })
  return String(res.body['accessToken'])
}

test('an invitation can be emailed; the code and a link arrive, the address is not stored', async () => {
  const h = harness({ mail: true })
  const token = await owner(h)
  const res = await h.request('POST', '/api/admin/invites', { token, body: { label: 'New hire', email: 'dev@example.test' } })
  assert.equal(res.status, 201)
  assert.equal(res.body['emailed'], true)
  const mail = h.outbox.find((m) => m.to === 'dev@example.test')!
  assert.ok(mail.text.includes(String(res.body['code'])))
  assert.match(mail.text, /\/app\/\?invite=/)
  assert.equal(JSON.stringify(h.store.dump()).includes('dev@example.test'), false, 'the address is nowhere in the table')
})

test('without SMTP, emailing an invitation says so; the test route needs mail and a staff permission', async () => {
  const h = harness()
  const token = await owner(h)
  const res = await h.request('POST', '/api/admin/invites', { token, body: { label: 'x', email: 'dev@example.test' } })
  assert.equal(res.status, 503)
  assert.equal(res.body['error'], 'unavailable')
  assert.equal((await h.request('POST', '/api/admin/mail/test', { token, body: { to: 'me@example.test' } })).status, 503)

  const m = harness({ mail: true })
  const t2 = await owner(m)
  assert.equal((await m.request('POST', '/api/admin/mail/test', { token: t2, body: { to: 'me@example.test' } })).status, 200)
  assert.equal(m.outbox.at(-1)!.subject, 'Vault test message')
})
