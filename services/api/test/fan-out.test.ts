// The admin console reads one row per account. On MySQL the pool holds four
// connections and a short queue, so sending every read at once failed a
// server with a few dozen accounts (overview and users list answered 500).
// Here the store behaves like that pool: more than 36 calls in flight is an
// error, and each call takes a moment, as a database round trip does.

import test from 'node:test'
import assert from 'node:assert/strict'

import { mapLimit } from '../src/limit.js'
import { fixtureB64, harness, registration } from './harness.js'

function likeAPool(store: Record<string, unknown>, max = 36) {
  let inFlight = 0, peak = 0
  for (const name of ['get', 'put', 'query', 'delete']) {
    const original = (store[name] as (...a: unknown[]) => Promise<unknown>).bind(store)
    store[name] = async (...args: unknown[]) => {
      inFlight++; peak = Math.max(peak, inFlight)
      try {
        if (inFlight > max) throw new Error('Queue limit reached.')
        await new Promise((r) => setTimeout(r, 1))
        return await original(...args)
      } finally { inFlight-- }
    }
  }
  return () => peak
}

test('mapLimit keeps order and never runs more than the limit at once', async () => {
  let running = 0, most = 0
  const out = await mapLimit([5, 4, 3, 2, 1, 0], async (n) => {
    running++; most = Math.max(most, running)
    await new Promise((r) => setTimeout(r, n))
    running--
    return n * 2
  }, 2)
  assert.deepEqual(out, [10, 8, 6, 4, 2, 0])
  assert.equal(most, 2)
  assert.deepEqual(await mapLimit([], async () => 1), [])
})

test('with sixty accounts, the overview, users list and insights stay within a small pool', async () => {
  const OWNER = 'owner@example.com'
  const h = harness({ adminEmails: [OWNER], allowRegistration: true })
  const owner = String((await h.request('POST', '/api/auth/register', { ip: '198.51.100.1', body: registration({ email: OWNER, authKey: fixtureB64(OWNER) }) })).body['accessToken'])
  for (let i = 0; i < 60; i++) {
    await h.request('POST', '/api/auth/register', { ip: `198.51.${100 + (i >> 6)}.${(i % 60) + 2}`, body: registration({ email: `p${i}@example.com`, authKey: fixtureB64(`p${i}`) }) })
  }
  const peak = likeAPool(h.app.store as unknown as Record<string, unknown>)
  for (const path of ['/api/admin/overview', '/api/admin/users?limit=50', '/api/admin/users?twoFactor=off&limit=200', '/api/admin/insights']) {
    const r = await h.request('GET', path, { token: owner })
    assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body)}`)
  }
  assert.ok(peak() <= 36, `peak ${peak()} calls in flight`)
})
