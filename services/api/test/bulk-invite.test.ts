// Inviting many people at once.

import test from 'node:test'
import assert from 'node:assert/strict'

import { fixtureB64, harness, registration } from './harness.js'

async function setup(mail = true) {
  const h = harness({ adminEmails: ['owner@example.com'], allowRegistration: true, mail })
  const owner = await h.request('POST', '/api/auth/register', { body: registration({ email: 'owner@example.com', authKey: fixtureB64('owner') }) })
  const user = await h.request('POST', '/api/auth/register', { body: registration({ email: 'u@example.com', authKey: fixtureB64('u') }) })
  h.app.allowRegistration = false
  await h.request('PUT', '/api/admin/settings', { token: String(owner.body['accessToken']), body: { registration: 'invite' } })
  return { h, owner: String(owner.body['accessToken']), user: String(user.body['accessToken']) }
}

const bulk = (h: ReturnType<typeof harness>, token: string, body: unknown) => h.request('POST', '/api/admin/invites/bulk', { token, body })

test('everyone gets an email with their own working code; addresses are not stored', async () => {
  const { h, owner } = await setup()
  const res = await bulk(h, owner, { people: [{ email: 'Asha@Example.org', name: 'Asha (finance)' }, { email: 'ravi@example.org' }], days: 14 })
  assert.equal(res.status, 201)
  const results = res.body['results'] as Array<Record<string, unknown>>
  assert.deepEqual(results.map((r) => [r['email'], r['label'], r['emailed']]), [['asha@example.org', 'Asha (finance)', true], ['ravi@example.org', 'Invitation 2', true]])
  assert.equal(results[0]!['code'], undefined, 'an emailed code is not shown again')
  assert.equal(h.outbox.length, 2)
  const codes = h.outbox.map((m) => /enter the code: (\S+)/.exec(m.text)![1]!)
  assert.notEqual(codes[0], codes[1])
  assert.ok(!JSON.stringify(h.store.dump()).includes('asha@example.org'))
  const reg = await h.request('POST', '/api/auth/register', { body: registration({ email: 'asha@example.org', authKey: fixtureB64('asha'), inviteCode: codes[0] }) })
  assert.equal(reg.status, 201)
})

test('without mail, the codes come back to hand out', async () => {
  const { h, owner } = await setup(false)
  const res = await bulk(h, owner, { people: [{ email: 'a@example.org' }, { email: 'b@example.org' }] })
  const results = res.body['results'] as Array<Record<string, unknown>>
  assert.equal(res.body['mail'], false)
  for (const r of results) { assert.equal(r['emailed'], false); assert.match(String(r['code']), /^[A-Z0-9]{4}(-[A-Z0-9]{4}){5}$/) }
})

test('a bad line stops the whole batch before anything is made', async () => {
  const { h, owner } = await setup()
  const before = ((await h.request('GET', '/api/admin/invites', { token: owner })).body['invites'] as unknown[]).length
  for (const [people, msg] of [
    [[{ email: 'ok@example.org' }, { email: 'nope' }], /Line 2: not an email/],
    [[{ email: 'a@example.org' }, { email: 'A@example.org' }], /listed twice/],
    [[], /non-empty/],
    [Array.from({ length: 101 }, (_, i) => ({ email: `p${i}@example.org` })), /At most 100/],
  ] as const) {
    const res = await bulk(h, owner, { people })
    assert.equal(res.status, 400)
    assert.match(String(res.body['message']), msg)
  }
  assert.equal(((await h.request('GET', '/api/admin/invites', { token: owner })).body['invites'] as unknown[]).length, before)
  assert.equal(h.outbox.length, 0)
})

test('only staff who may invite, and staff roles only for those who may grant them', async () => {
  const { h, owner, user } = await setup()
  assert.equal((await bulk(h, user, { people: [{ email: 'a@example.org' }] })).status, 403)
  assert.equal((await bulk(h, owner, { people: [{ email: 'a@example.org' }], role: 'admin' })).status, 201)
  assert.equal((await bulk(h, owner, { people: [{ email: 'b@example.org' }], role: 'superuser' })).status, 400)
  const audit = (await h.request('GET', '/api/admin/audit', { token: owner })).body['records'] as Array<Record<string, unknown>>
  assert.ok(audit.some((r) => r['action'] === 'invite.bulk'))
})

test('inviting while registration is closed comes with a warning', async () => {
  const { h, owner } = await setup()
  assert.equal((await bulk(h, owner, { people: [{ email: 'a@example.org' }] })).body['warning'], undefined)
  await h.request('PUT', '/api/admin/settings', { token: owner, body: { registration: 'closed' } })
  assert.match(String((await bulk(h, owner, { people: [{ email: 'b@example.org' }] })).body['warning']), /Registration is closed/)
  assert.match(String((await h.request('POST', '/api/admin/invites', { token: owner, body: { label: 'One' } })).body['warning']), /Registration is closed/)
})
