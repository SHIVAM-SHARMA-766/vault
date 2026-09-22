// Tokens, rotation, and the properties that make a stolen one recoverable.

import test from 'node:test'
import assert from 'node:assert/strict'

import { fixtureB64, harness, registration, sealedBlob } from './harness.js'

async function registered() {
  const h = harness()
  const reg = registration()
  const res = await h.request('POST', '/api/auth/register', { body: reg })
  return { h, reg, tokens: res.body as { accessToken: string; refreshToken: string; userId: string } }
}

test('an access token authenticates, and a missing one does not', async () => {
  const { h, tokens } = await registered()
  assert.equal((await h.request('GET', '/api/auth/me', { token: tokens.accessToken })).status, 200)
  assert.equal((await h.request('GET', '/api/auth/me')).status, 401)
})

test('a tampered token is refused', async () => {
  const { h, tokens } = await registered()
  const [v, body, mac] = tokens.accessToken.split('.') as [string, string, string]
  const forged = `${v}.${body}.${mac.slice(0, -2)}AA`
  assert.equal((await h.request('GET', '/api/auth/me', { token: forged })).status, 401)
})

test('a token with an unsigned payload is refused', async () => {
  // The token format names no algorithm, so there is no "alg: none" to try —
  // this is the closest equivalent: a payload with a plausible signature.
  const { h, tokens } = await registered()
  const payload = Buffer.from(
    JSON.stringify({ sub: 'someone-else', typ: 'access', exp: 9_999_999_999 }),
  ).toString('base64url')
  const forged = `v1.${payload}.${tokens.accessToken.split('.')[2]}`
  assert.equal((await h.request('GET', '/api/auth/me', { token: forged })).status, 401)
})

test('an expired access token is refused', async () => {
  const { h, tokens } = await registered()
  h.setNow(Date.UTC(2026, 8, 22, 12, 0, 0) + 16 * 60 * 1000)
  assert.equal((await h.request('GET', '/api/auth/me', { token: tokens.accessToken })).status, 401)
})

test('a refresh token cannot be used as an access token', async () => {
  const { h, tokens } = await registered()
  assert.equal((await h.request('GET', '/api/auth/me', { token: tokens.refreshToken })).status, 401)
})

test('refreshing rotates the refresh token', async () => {
  const { h, tokens } = await registered()
  const res = await h.request('POST', '/api/auth/refresh', {
    body: { refreshToken: tokens.refreshToken },
  })
  assert.equal(res.status, 200)
  assert.notEqual(res.body['refreshToken'], tokens.refreshToken)
  assert.ok(typeof res.body['accessToken'] === 'string')
})

test('replaying a rotated refresh token revokes every session', async () => {
  // A refresh token presented twice is the signature of a stolen one: the
  // legitimate client already rotated it away. Dropping every session logs the
  // thief out along with the owner, who can simply sign in again.
  const { h, tokens } = await registered()
  const rotated = await h.request('POST', '/api/auth/refresh', {
    body: { refreshToken: tokens.refreshToken },
  })

  const replay = await h.request('POST', '/api/auth/refresh', {
    body: { refreshToken: tokens.refreshToken },
  })
  assert.equal(replay.status, 401)

  const afterReplay = await h.request('POST', '/api/auth/refresh', {
    body: { refreshToken: String(rotated.body['refreshToken']) },
  })
  assert.equal(afterReplay.status, 401, 'the honest client is logged out too')
})

test('logout revokes the session it is given', async () => {
  const { h, tokens } = await registered()
  await h.request('POST', '/api/auth/logout', {
    token: tokens.accessToken,
    body: { refreshToken: tokens.refreshToken },
  })
  const after = await h.request('POST', '/api/auth/refresh', {
    body: { refreshToken: tokens.refreshToken },
  })
  assert.equal(after.status, 401)
})

test('one user cannot reach another user partition', async () => {
  const h = harness()
  const a = await h.request('POST', '/api/auth/register', { body: registration() })
  const b = await h.request('POST', '/api/auth/register', {
    body: registration({ email: 'other@example.com' }),
  })

  await h.request('PUT', '/api/vault/entries/entry-aaaaaaaa', {
    token: String(a.body['accessToken']),
    body: { blob: sealedBlob('owner-a-entry') },
  })

  const seen = await h.request('GET', '/api/vault', { token: String(b.body['accessToken']) })
  assert.deepEqual(seen.body['entries'], [], "another user's entries are not visible")
})

test('repeated login attempts are rate limited', async () => {
  const h = harness()
  const reg = registration()
  await h.request('POST', '/api/auth/register', { body: reg })

  let limited = 0
  for (let i = 0; i < 20; i++) {
    const res = await h.request('POST', '/api/auth/login', {
      body: { email: reg['email'], authKey: fixtureB64('wrong-auth-key') },
    })
    if (res.status === 429) {
      limited++
      assert.ok(res.headers['retry-after'], 'a retry-after header is set')
    }
  }
  assert.ok(limited > 0, 'the limiter engaged')
})
