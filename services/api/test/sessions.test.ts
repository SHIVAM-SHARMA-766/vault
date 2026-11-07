// Signed-in devices: one stable row per device across refreshes, which one is
// current, naming one, and signing one out.

import test from 'node:test'
import assert from 'node:assert/strict'

import { describeDevice } from '../src/device.js'
import { fixtureB64, harness, registration } from './harness.js'

interface Row { id: string; device: string; name?: string; ip: string; createdAt: string; lastUsedAt: string; current: boolean }

async function twoDevices() {
  const h = harness()
  const reg = registration()
  const first = (await h.request('POST', '/api/auth/register', { body: reg })).body as { accessToken: string; refreshToken: string }
  const second = (await h.request('POST', '/api/auth/login', {
    ip: '198.51.100.9', body: { email: reg['email'], authKey: fixtureB64('auth-key') },
  })).body as { accessToken: string; refreshToken: string }
  return { h, first, second }
}

const rows = async (h: ReturnType<typeof harness>, token: string) =>
  (await h.request('GET', '/api/sessions', { token })).body['sessions'] as Row[]

test('each sign-in is a device, and the caller is marked current', async () => {
  const { h, first, second } = await twoDevices()
  const seen = await rows(h, second.accessToken)
  assert.equal(seen.length, 2)
  assert.equal(seen[0]!.current, true, 'the current device is listed first')
  assert.equal(seen[0]!.ip, '198.51.100.9')
  assert.equal(seen.filter((r) => r.current).length, 1)
  assert.equal((await rows(h, first.accessToken)).find((r) => r.current)!.ip, '203.0.113.7')
})

test('refreshing keeps the same device row', async () => {
  const { h, first } = await twoDevices()
  const before = (await rows(h, first.accessToken)).find((r) => r.current)!
  const refreshed = (await h.request('POST', '/api/auth/refresh', { body: { refreshToken: first.refreshToken } })).body as { accessToken: string }
  const after = await rows(h, refreshed.accessToken)
  assert.equal(after.length, 2, 'no extra row from rotation')
  const me = after.find((r) => r.current)!
  assert.equal(me.id, before.id)
  assert.equal(me.createdAt, before.createdAt)
})

test('a device can be named, and the name survives a refresh', async () => {
  const { h, first } = await twoDevices()
  const mine = (await rows(h, first.accessToken)).find((r) => r.current)!
  assert.equal((await h.request('PUT', `/api/sessions/${mine.id}/name`, { token: first.accessToken, body: { name: 'Office laptop' } })).status, 200)
  const refreshed = (await h.request('POST', '/api/auth/refresh', { body: { refreshToken: first.refreshToken } })).body as { accessToken: string }
  assert.equal((await rows(h, refreshed.accessToken)).find((r) => r.current)!.name, 'Office laptop')
  assert.equal((await h.request('PUT', `/api/sessions/${mine.id}/name`, { token: first.accessToken, body: { name: 'x'.repeat(41) } })).status, 400)
})

test('signing a device out stops its refresh token at once', async () => {
  const { h, first, second } = await twoDevices()
  const other = (await rows(h, first.accessToken)).find((r) => !r.current)!
  assert.equal((await h.request('DELETE', `/api/sessions/${other.id}`, { token: first.accessToken })).status, 200)
  assert.equal((await rows(h, first.accessToken)).length, 1)
  const activity = (await h.request('GET', '/api/activity', { token: first.accessToken })).body['events'] as { kind: string }[]
  assert.ok(activity.some((e) => e.kind === 'revoke-session'))
  assert.equal((await h.request('DELETE', `/api/sessions/${other.id}`, { token: first.accessToken })).status, 404)
  // Presenting the signed-out refresh token looks like theft: every session
  // ends, and with the per-request check, every access token stops at once.
  assert.equal((await h.request('POST', '/api/auth/refresh', { body: { refreshToken: second.refreshToken } })).status, 401)
  assert.equal((await h.request('GET', '/api/vault', { token: first.accessToken })).status, 401)
})

test('a signed-out device is refused at once, not when its access token expires', async () => {
  const { h, first, second } = await twoDevices()
  assert.equal((await h.request('GET', '/api/vault', { token: second.accessToken })).status, 200)
  const other = (await rows(h, first.accessToken)).find((r) => !r.current)!
  await h.request('DELETE', `/api/sessions/${other.id}`, { token: first.accessToken })
  assert.equal((await h.request('GET', '/api/vault', { token: second.accessToken })).status, 401)
  assert.equal((await h.request('GET', '/api/vault', { token: first.accessToken })).status, 200, 'the other device carries on')
})

test('sign out everywhere stops every access token at once', async () => {
  const { h, first, second } = await twoDevices()
  assert.equal((await h.request('POST', '/api/auth/logout', { token: first.accessToken, body: { all: true } })).status, 200)
  for (const t of [first.accessToken, second.accessToken]) assert.equal((await h.request('GET', '/api/vault', { token: t })).status, 401)
})

test("one account cannot see or sign out another's devices", async () => {
  const { h, first } = await twoDevices()
  const stranger = (await h.request('POST', '/api/auth/register', { body: registration({ email: 'someone-else@example.test' }) })).body as { accessToken: string }
  const mine = (await rows(h, first.accessToken))[0]!
  assert.equal((await rows(h, stranger.accessToken)).length, 1)
  assert.equal((await h.request('DELETE', `/api/sessions/${mine.id}`, { token: stranger.accessToken })).status, 404)
  assert.equal((await rows(h, first.accessToken)).length, 2)
})

test('user agents are described in words', () => {
  assert.equal(describeDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'), 'Chrome on Windows')
  assert.equal(describeDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0'), 'Edge on Windows')
  assert.equal(describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'), 'Safari on iOS')
  assert.equal(describeDevice('Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0'), 'Firefox on Linux')
  assert.equal(describeDevice('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36'), 'Chrome on Android')
  assert.equal(describeDevice(undefined), 'Unknown device')
})

test('sign-out ends the session its refresh token belongs to, with no access token', async () => {
  const { h, first, second } = await twoDevices()
  assert.equal((await h.request('POST', '/api/auth/signout', { body: { refreshToken: second.refreshToken } })).status, 200)
  assert.equal((await rows(h, first.accessToken)).length, 1)
  assert.equal((await h.request('POST', '/api/auth/refresh', { body: { refreshToken: second.refreshToken } })).status, 401)
  // Unknown or forged tokens get the same answer and change nothing.
  assert.equal((await h.request('POST', '/api/auth/signout', { body: { refreshToken: 'v1.junk.junk' } })).status, 200)
  assert.equal((await h.request('POST', '/api/auth/signout', { body: {} })).status, 400)
})
