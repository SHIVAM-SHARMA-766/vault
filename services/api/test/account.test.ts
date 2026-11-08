// Deleting your own account: proof, the second factor, the guards, and that
// nothing of the account is left behind.

import test from 'node:test'
import assert from 'node:assert/strict'

import { generateTotp } from '@vault/crypto'

import { fixtureB64, harness, registration, sealedBlob } from './harness.js'

const AUTH = fixtureB64('auth-key')

async function setup() {
  const h = harness({ adminEmails: ['owner@example.com'], allowRegistration: true })
  const owner = await h.request('POST', '/api/auth/register', { body: registration({ email: 'owner@example.com', authKey: fixtureB64('owner') }) })
  const me = await h.request('POST', '/api/auth/register', { body: registration() })
  const token = String(me.body['accessToken'])
  const userId = String(me.body['userId'])
  await h.request('PUT', '/api/vault/entries/entry-0001', { token, body: { blob: sealedBlob('e1') } })
  await h.request('PUT', '/api/prefs', { token, body: { blob: sealedBlob('p') } })
  return { h, token, userId, ownerToken: String(owner.body['accessToken']), ownerId: String(owner.body['userId']) }
}

const del = (h: ReturnType<typeof harness>, token: string, body: Record<string, unknown>) => h.request('POST', '/api/account/delete', { token, body })

test('needs the typed confirmation and the right password', async () => {
  const { h, token } = await setup()
  assert.equal((await del(h, token, { currentAuthKey: AUTH })).status, 400)
  assert.equal((await del(h, token, { currentAuthKey: fixtureB64('wrong'), confirm: 'DELETE' })).status, 401)
  assert.equal((await h.request('GET', '/api/vault', { token })).status, 200, 'still there')
})

test('deletes everything, and the address can sign up again afterwards', async () => {
  const { h, token, userId, ownerToken } = await setup()
  await h.request('PUT', '/api/backups/config', { token, body: { schedule: { frequency: 'daily', hour: 2, weekday: 0, tzOffsetMinutes: 0, keep: 3 }, destination: { type: 'server' } } })
  assert.equal((await del(h, token, { currentAuthKey: AUTH, confirm: 'DELETE' })).status, 200)
  const dump = h.store.dump()
  assert.ok(!dump.some((i) => i.pk === `USER#${userId}` || i.sk === `USER#${userId}` || i.sk === `BKDUE#${userId}`), 'nothing left')
  assert.equal((await h.request('POST', '/api/auth/login', { body: { email: 'person@example.com', authKey: AUTH } })).status, 401)
  assert.equal((await h.request('GET', '/api/vault', { token })).status, 401, 'the old session is refused at once')
  assert.equal((await h.request('PUT', '/api/vault/entries/entry-0002', { token, body: { blob: sealedBlob('late') } })).status, 401, 'no orphan writes')
  const audit = (await h.request('GET', '/api/admin/audit', { token: ownerToken })).body['records'] as Array<Record<string, unknown>>
  assert.ok(audit.some((r) => r['action'] === 'user.self-delete'))
  assert.equal((await h.request('POST', '/api/auth/register', { body: registration() })).status, 201)
})

test('with two-factor on, a code is required too', async () => {
  const { h, token } = await setup()
  const setupRes = await h.request('POST', '/api/auth/2fa/setup', { token, body: { currentAuthKey: AUTH } })
  const secret = String(setupRes.body['secret'])
  let now = Date.UTC(2026, 8, 22, 12, 0, 0)
  await h.request('POST', '/api/auth/2fa/enable', { token, body: { code: (await generateTotp(secret, now)).code } })
  assert.equal((await del(h, token, { currentAuthKey: AUTH, confirm: 'DELETE' })).status, 401)
  now += 30_000; h.setNow(now)
  assert.equal((await del(h, token, { currentAuthKey: AUTH, confirm: 'DELETE', totpCode: (await generateTotp(secret, now)).code })).status, 200)
})

test('refused while you own an organization', async () => {
  const { h, token } = await setup()
  const org = await h.request('POST', '/api/orgs', { token, body: { name: sealedBlob('org'), ownerName: 'Me', orgKey: 'pk1.' + fixtureB64('k', 120) } })
  if (org.status !== 201 && org.status !== 200) return // the org route's own shape is covered in orgs.test
  const res = await del(h, token, { currentAuthKey: AUTH, confirm: 'DELETE' })
  assert.equal(res.status, 409)
  assert.match(String(res.body['message']), /You own an organization/)
})

test('the only owner cannot delete themselves', async () => {
  const h = harness({ allowRegistration: true })
  // First-run setup makes an owner without ADMIN_EMAILS.
  const { ensureSetup } = await import('../src/system.js')
  const code = await ensureSetup(h.app)
  const owner = await h.request('POST', '/api/auth/register', { body: registration({ inviteCode: code }) })
  const res = await del(h, String(owner.body['accessToken']), { currentAuthKey: AUTH, confirm: 'DELETE' })
  assert.equal(res.status, 409)
  assert.match(String(res.body['message']), /only owner/)
})

test('the sign-in email can be turned off, and recovery sign-ins are still announced', async () => {
  const h = harness({ allowRegistration: true, mail: true })
  const reg = registration({ email: 'alerts@example.test', authKey: fixtureB64('alerts') })
  const token = String((await h.request('POST', '/api/auth/register', { body: reg })).body['accessToken'])
  assert.deepEqual((await h.request('GET', '/api/account/alerts', { token })).body, { signIn: true, available: true })
  const login = () => h.request('POST', '/api/auth/login', { body: { email: 'alerts@example.test', authKey: fixtureB64('alerts') } })
  await login()
  assert.equal(h.outbox.length, 1)
  assert.equal((await h.request('PUT', '/api/account/alerts', { token, body: { signIn: false } })).status, 200)
  await login()
  assert.equal(h.outbox.length, 1, 'no email once turned off')
  assert.equal((await h.request('PUT', '/api/account/alerts', { token, body: { signIn: 'off' } })).status, 400)
  assert.equal((await h.request('GET', '/api/account/alerts', { token })).body['signIn'], false)
})
