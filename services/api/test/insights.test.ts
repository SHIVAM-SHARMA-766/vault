// The security dashboard, reports and weekly digest (admin console phase 2).

import test from 'node:test'
import assert from 'node:assert/strict'

import { dispatch } from '../src/app.js'
import { tickDigest, toCsv } from '../src/routes/insights.js'
import { fixtureB64, harness, registration } from './harness.js'

const OWNER = 'owner@example.com'

async function setup() {
  const h = harness({ adminEmails: [OWNER], allowRegistration: true, mail: true })
  const owner = String((await h.request('POST', '/api/auth/register', { ip: '198.51.100.1', body: registration({ email: OWNER, authKey: fixtureB64('owner') }) })).body['accessToken'])
  for (let i = 0; i < 3; i++) await h.request('POST', '/api/auth/register', { ip: `198.51.100.${i + 2}`, body: registration({ email: `p${i}@example.com`, authKey: fixtureB64(`p${i}`) }) })
  return { h, owner }
}

test('sign-ins, failed sign-ins and new vaults are counted per day, with nothing about who', async () => {
  const { h, owner } = await setup()
  // A legacy sign-in that works, and one with the wrong key.
  assert.equal((await h.request('POST', '/api/auth/login', { ip: '198.51.100.20', body: { email: 'p0@example.com', authKey: fixtureB64('p0') } })).status, 200)
  assert.equal((await h.request('POST', '/api/auth/login', { ip: '198.51.100.21', body: { email: 'p0@example.com', authKey: fixtureB64('wrong') } })).status, 401)
  const res = await h.request('GET', '/api/admin/insights', { token: owner })
  assert.equal(res.status, 200)
  const today = (res.body['daily'] as { day: string; signin: number; 'signin-failed': number; signup: number }[]).at(-1)!
  assert.deepEqual([today.signin, today['signin-failed'], today.signup], [1, 1, 4])
  assert.equal((res.body['daily'] as unknown[]).length, 30)
  const rows = await h.app.store.query('STATS')
  assert.ok(rows.every((r) => Object.keys(r).every((k) => ['pk', 'sk', 'count', 'expiresAt'].includes(k))), 'counters only')
})

test('needs attention: staff and accounts without two-factor, and where to look', async () => {
  const { h, owner } = await setup()
  const body = (await h.request('GET', '/api/admin/insights', { token: owner })).body
  const items = body['attention'] as { id: string; level: string; count: number; go: { tab: string } }[]
  const staff = items.find((a) => a.id === 'staff-2fa')!
  assert.equal(staff.level, 'high')
  assert.equal(staff.count, 1)
  assert.equal(items.find((a) => a.id === 'no-2fa')!.count, 4)
  assert.equal(items[0]!.level, 'high', 'most urgent first')
  assert.deepEqual(body['twoFactor'], { on: 0, off: 4 })
  // Only staff with the overview permission see it.
  const user = String((await h.request('POST', '/api/auth/login', { ip: '198.51.100.30', body: { email: 'p1@example.com', authKey: fixtureB64('p1') } })).body['accessToken'])
  assert.equal((await h.request('GET', '/api/admin/insights', { token: user })).status, 403)
})

test('reports come as JSON or CSV; a cell that looks like a formula is defused', async () => {
  const { h, owner } = await setup()
  const list = (await h.request('GET', '/api/admin/reports', { token: owner })).body['reports'] as { kind: string }[]
  assert.ok(list.some((r) => r.kind === 'two-factor'))
  const staff = (await h.request('GET', '/api/admin/reports/staff', { token: owner })).body
  assert.deepEqual(staff['rows'], [[OWNER, 'owner', 'active', false, staff['rows'] && (staff['rows'] as unknown[][])[0]![4]]])
  // CSV is not JSON, so straight to the router.
  const csv = await dispatch(h.app, { rawPath: '/api/admin/reports/two-factor', rawQueryString: 'format=csv', headers: { 'x-vault-auth': `Bearer ${owner}` }, requestContext: { http: { method: 'GET', sourceIp: '203.0.113.7' } } })
  assert.equal(csv.statusCode, 200)
  assert.match(String(csv.headers?.['content-type']), /text\/csv/)
  assert.match(csv.body, /^account,role,status,two_factor,last_sign_in\n/)
  assert.equal(csv.body.split('\n').length, 5)
  assert.equal((await h.request('GET', '/api/admin/reports/nope', { token: owner })).status, 404)
  assert.equal(toCsv({ columns: ['a'], rows: [['=HYPERLINK("x")'], ['+1'], ['plain']] }), 'a\n"\'=HYPERLINK(""x"")"\n"\'+1"\nplain')
})

test('the weekly digest goes to owners and admins once a week, and can be turned off', async () => {
  const { h, owner } = await setup()
  const users = (await h.request('GET', '/api/admin/users', { token: owner })).body['users'] as { userId: string; email: string }[]
  await h.request('PUT', `/api/admin/users/${users.find((u) => u.email === 'p0@example.com')!.userId}/role`, { token: owner, body: { role: 'admin' } })
  assert.equal(await tickDigest(h.app), 2)
  await new Promise((r) => setTimeout(r, 10))
  const sent = h.outbox.filter((m) => /weekly summary/.test(m.subject))
  assert.deepEqual(sent.map((m) => m.to).sort(), ['owner@example.com', 'p0@example.com'])
  assert.match(sent[0]!.text, /Staff without two-factor sign-in/)
  assert.equal(await tickDigest(h.app), 0, 'not again within the week')

  const settings = (await h.request('GET', '/api/admin/settings', { token: owner })).body as { policy: Record<string, unknown> }
  assert.equal(settings.policy['weeklyDigest'], true)
  assert.equal((await h.request('PUT', '/api/admin/settings', { token: owner, body: { policy: { ...settings.policy, weeklyDigest: false } } })).status, 200)
  assert.equal((await h.request('POST', '/api/admin/digest', { token: owner })).status, 200, 'sending now still works')
})
