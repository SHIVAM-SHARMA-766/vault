// Server policies (G1 session, G3 password, G7 retention): set by an admin,
// validated against fixed choices, shown to the accounts that miss them,
// and applied to sessions and logs.

import test from 'node:test'
import assert from 'node:assert/strict'

import { applyRetention } from '../src/retention.js'
import { fixtureB64, harness, registration } from './harness.js'

const DAY = 86_400_000

async function setup() {
  const h = harness({ adminEmails: ['owner@example.com'], allowRegistration: true })
  const owner = (await h.request('POST', '/api/auth/register', { body: registration({ email: 'owner@example.com', authKey: fixtureB64('owner') }) })).body
  const user = (await h.request('POST', '/api/auth/register', { body: registration({ email: 'user@example.com', authKey: fixtureB64('user') }) })).body
  h.app.allowRegistration = false
  return { h, owner: String(owner['accessToken']), user: String(user['accessToken']), userRefresh: String(user['refreshToken']) }
}

const POLICY = { requireTwoFactor: false, minPasswordScore: 0, maxIdleMinutes: null, sessionDays: null, activityDays: 90, auditDays: 365 }
const setPolicy = (h: Awaited<ReturnType<typeof setup>>['h'], token: string, policy: Record<string, unknown>) =>
  h.request('PUT', '/api/admin/settings', { token, body: { policy: { ...POLICY, ...policy } } })

test('with nothing set, the policy is the permissive default', async () => {
  const { h, owner, user } = await setup()
  assert.deepEqual((await h.request('GET', '/api/admin/settings', { token: owner })).body['policy'], POLICY)
  const me = (await h.request('GET', '/api/auth/me', { token: user })).body
  assert.deepEqual(me['policy'], { requireTwoFactor: false, minPasswordScore: 0, maxIdleMinutes: null })
  assert.equal(me['policyGap'], null)
  assert.equal((await h.request('GET', '/api/instance')).body['minPasswordScore'], 0)
})

test('only offered choices are accepted, and only from staff who may change settings', async () => {
  const { h, owner, user } = await setup()
  for (const bad of [
    { requireTwoFactor: 'yes' }, { minPasswordScore: 5 }, { maxIdleMinutes: 7 }, { sessionDays: 3 },
    { activityDays: 1 }, { auditDays: 30 }, { auditDays: '365' },
  ]) {
    assert.equal((await setPolicy(h, owner, bad)).status, 400, JSON.stringify(bad))
  }
  assert.equal((await h.request('PUT', '/api/admin/settings', { token: owner, body: { policy: 'strict' } })).status, 400)
  assert.equal((await setPolicy(h, user, { requireTwoFactor: true })).status, 403)
  assert.deepEqual((await h.request('GET', '/api/admin/settings', { token: owner })).body['policy'], POLICY, 'nothing changed')
})

test('saving a policy is audited and leaves registration and profile alone', async () => {
  const { h, owner } = await setup()
  await h.request('PUT', '/api/admin/settings', { token: owner, body: { registration: 'invite', profile: { name: 'Acme', supportEmail: '', supportUrl: '' } } })
  assert.equal((await setPolicy(h, owner, { requireTwoFactor: true, minPasswordScore: 3, sessionDays: 7 })).status, 200)
  const s = (await h.request('GET', '/api/admin/settings', { token: owner })).body
  assert.equal(s['registration'], 'invite')
  assert.equal((s['profile'] as { name: string }).name, 'Acme')
  assert.equal((s['policy'] as { sessionDays: number }).sessionDays, 7)
  const records = (await h.request('GET', '/api/admin/audit', { token: owner })).body['records'] as { action: string; detail: string }[]
  const rec = records.find((r) => r.action === 'settings.policy')!
  assert.match(rec.detail, /2fa/)
  assert.match(rec.detail, /score>=3/)
  assert.match(rec.detail, /session=7d/)
})

test('an account that misses the policy is told, and admins see it; meeting it clears both', async () => {
  const { h, owner, user } = await setup()
  await h.request('PUT', '/api/auth/password-score', { token: user, body: { score: 2 } })
  await h.request('PUT', '/api/auth/password-score', { token: owner, body: { score: 4 } })
  await setPolicy(h, owner, { minPasswordScore: 3 })
  assert.equal((await h.request('GET', '/api/instance')).body['minPasswordScore'], 3)
  const me = (await h.request('GET', '/api/auth/me', { token: user })).body
  assert.match(String(me['policyGap']), /stronger master password/)
  const users = (await h.request('GET', '/api/admin/users', { token: owner })).body['users'] as { policyGap: boolean; userId: string }[]
  assert.deepEqual(users.map((u) => u.policyGap).sort(), [false, true])
  assert.equal((await h.request('GET', '/api/admin/overview', { token: owner })).body['policyGapUsers'], 1)

  await h.request('PUT', '/api/auth/password-score', { token: user, body: { score: 4 } })
  assert.equal((await h.request('GET', '/api/auth/me', { token: user })).body['policyGap'], null)
  assert.equal((await h.request('GET', '/api/admin/overview', { token: owner })).body['policyGapUsers'], 0)
})

test('requiring two-factor names it as the gap, without locking anyone out', async () => {
  const { h, owner, user } = await setup()
  await setPolicy(h, owner, { requireTwoFactor: true, maxIdleMinutes: 5 })
  const me = (await h.request('GET', '/api/auth/me', { token: user })).body
  assert.match(String(me['policyGap']), /two-factor/)
  assert.equal((me['policy'] as { maxIdleMinutes: number }).maxIdleMinutes, 5)
  assert.equal((await h.request('GET', '/api/vault', { token: user })).status, 200, 'the vault still opens')
})

test('a session policy ends a device sign-in at a fixed time, however often it refreshes', async () => {
  const { h, owner, userRefresh } = await setup()
  await setPolicy(h, owner, { sessionDays: 1 })
  const start = h.app.now()
  let refresh = userRefresh
  for (const hours of [6, 12, 20]) {
    h.setNow(start + hours * 3_600_000)
    const res = await h.request('POST', '/api/auth/refresh', { body: { refreshToken: refresh } })
    assert.equal(res.status, 200, `refresh at ${hours} h`)
    refresh = String(res.body['refreshToken'])
  }
  h.setNow(start + 25 * 3_600_000)
  assert.equal((await h.request('POST', '/api/auth/refresh', { body: { refreshToken: refresh } })).status, 401)
})

test('a session policy set later applies to devices already signed in', async () => {
  const { h, userRefresh } = await setup()
  const start = h.app.now()
  h.setNow(start + 8 * DAY)
  // The owner's access token has expired by now; sign in again to set it.
  const again = (await h.request('POST', '/api/auth/login', { body: { email: 'owner@example.com', authKey: fixtureB64('owner') } })).body
  await setPolicy(h, String(again['accessToken']), { sessionDays: 7 })
  assert.equal((await h.request('POST', '/api/auth/refresh', { body: { refreshToken: userRefresh } })).status, 401)
})

test('without a session policy, refreshing keeps a device signed in past any fixed time', async () => {
  const { h, userRefresh } = await setup()
  const start = h.app.now()
  let refresh = userRefresh
  for (let day = 20; day <= 100; day += 20) {
    h.setNow(start + day * DAY)
    const res = await h.request('POST', '/api/auth/refresh', { body: { refreshToken: refresh } })
    assert.equal(res.status, 200, `day ${day}`)
    refresh = String(res.body['refreshToken'])
  }
})

test('new log rows expire after the retention the policy sets', async () => {
  const { h, owner } = await setup()
  await setPolicy(h, owner, { activityDays: 30, auditDays: 730 })
  // A later instant, so the rows written now sort after those from setup.
  const t0 = h.app.now() + 60_000
  h.setNow(t0)
  await h.request('POST', '/api/auth/login', { body: { email: 'user@example.com', authKey: fixtureB64('user') } })
  await setPolicy(h, owner, { activityDays: 30, auditDays: 730, sessionDays: 7 })
  const nowS = Math.floor(t0 / 1000)
  const newest = (prefix: string) => Promise.resolve(h.store.dump())
    .then((rows) => rows.filter((r) => r.sk.startsWith(prefix)).sort((a, b) => a.sk.localeCompare(b.sk)).pop()!)
  assert.equal((await newest('AUDIT#'))['expiresAt'], nowS + 730 * 86_400)
  assert.equal((await newest('ACT#'))['expiresAt'], nowS + 30 * 86_400)
})

test('shortening retention removes older rows at once; lengthening removes nothing', async () => {
  const { h, owner, user } = await setup()
  const start = h.app.now()
  await h.request('POST', '/api/auth/logout', { token: user, body: { all: true } })  // an activity row at day 0
  await setPolicy(h, owner, { auditDays: 365 })                                       // an audit row at day 0
  h.setNow(start + 100 * DAY)
  const fresh = String((await h.request('POST', '/api/auth/login', { body: { email: 'owner@example.com', authKey: fixtureB64('owner') } })).body['accessToken'])
  const before = h.store.dump().filter((r) => r.sk.startsWith('AUDIT#') || r.sk.startsWith('ACT#')).length

  await setPolicy(h, fresh, { activityDays: 365, auditDays: 1825 })
  assert.equal(h.store.dump().filter((r) => r.sk.startsWith('AUDIT#') || r.sk.startsWith('ACT#')).length, before + 1, 'only the new audit row')

  await setPolicy(h, fresh, { activityDays: 30, auditDays: 90 })
  const left = h.store.dump().filter((r) => r.sk.startsWith('AUDIT#') || r.sk.startsWith('ACT#'))
  const cutoff = new Date(start + 70 * DAY).toISOString()
  assert.ok(left.every((r) => String(r['at']) >= cutoff), 'no row older than 30 days of activity / 90 of audit survives')
  assert.ok(left.some((r) => r.sk.startsWith('AUDIT#') && r['action'] === 'settings.policy'), 'the change itself is recorded')
  assert.deepEqual(await applyRetention(h.app), { audit: 0, activity: 0, orgEvents: 0 }, 'a second pass finds nothing')
})
