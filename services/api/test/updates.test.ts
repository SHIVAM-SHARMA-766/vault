// The admin panel's update check: version comparison, the release feed,
// caching, failures, and staying silent when turned off.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { compareVersions, forgetUpdateCheck } from '../src/updates.js'
import { fixtureB64, harness, registration } from './harness.js'

test('versions compare as numbers, with or without a v, ignoring suffixes', () => {
  assert.equal(compareVersions('0.9.0', '0.10.0'), -1)
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0)
  assert.equal(compareVersions('1.10.0', 'v1.9.9'), 1)
  assert.equal(compareVersions('1.2.3-rc.1', '1.2.3'), 0)
  assert.equal(compareVersions('dev', '1.0.0'), null)
})

async function feed(status: number, body: unknown) {
  let hits = 0
  const server = createServer((req, res) => {
    hits++
    assert.equal(req.headers['user-agent'], 'vault-update-check', 'a generic client name, nothing about the install')
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/latest`, hits: () => hits }
}

async function owner(options: Parameters<typeof harness>[0]) {
  forgetUpdateCheck()
  const h = harness({ adminEmails: ['owner@example.com'], allowRegistration: true, ...options })
  const o = await h.request('POST', '/api/auth/register', { body: registration({ email: 'owner@example.com', authKey: fixtureB64('owner') }) })
  const u = await h.request('POST', '/api/auth/register', { body: registration({ email: 'u@example.com', authKey: fixtureB64('u') }) })
  return { h, token: String(o.body['accessToken']), user: String(u.body['accessToken']) }
}

test('a newer release is reported with its link and notes, and cached', async () => {
  const f = await feed(200, { tag_name: 'v1.4.0', html_url: 'https://github.com/x/vault/releases/tag/v1.4.0', published_at: '2026-11-01T00:00:00Z', body: 'Fixes.' })
  try {
    const { h, token } = await owner({ version: '1.3.2', updateUrl: f.url })
    const res = await h.request('GET', '/api/admin/update', { token })
    assert.equal(res.status, 200)
    assert.equal(res.body['current'], '1.3.2')
    assert.equal(res.body['latest'], 'v1.4.0')
    assert.equal(res.body['newer'], true)
    assert.equal(res.body['url'], 'https://github.com/x/vault/releases/tag/v1.4.0')
    assert.equal(res.body['notes'], 'Fixes.')
    await h.request('GET', '/api/admin/update', { token })
    assert.equal(f.hits(), 1, 'cached')
    await h.request('GET', '/api/admin/update?refresh=1', { token })
    assert.equal(f.hits(), 2, 'refresh asks again')
  } finally {
    f.server.close()
  }
})

test('up to date, or a development build, is not "newer"', async () => {
  const f = await feed(200, { tag_name: 'v1.3.2', html_url: 'https://example.com/r' })
  try {
    const a = await owner({ version: '1.3.2', updateUrl: f.url })
    assert.equal((await a.h.request('GET', '/api/admin/update', { token: a.token })).body['newer'], false)
    const b = await owner({ version: 'dev', updateUrl: f.url })
    const res = await b.h.request('GET', '/api/admin/update', { token: b.token })
    assert.equal(res.body['newer'], false)
    assert.equal(res.body['latest'], 'v1.3.2')
  } finally {
    f.server.close()
  }
})

test('no release yet, a failing feed, or an unsafe link are reported calmly', async () => {
  const none = await feed(404, { message: 'Not Found' })
  const broken = await feed(500, {})
  const sneaky = await feed(200, { tag_name: 'v9.0.0', html_url: 'javascript:alert(1)' })
  try {
    let o = await owner({ version: '1.0.0', updateUrl: none.url })
    assert.match(String((await o.h.request('GET', '/api/admin/update', { token: o.token })).body['error']), /No release has been published/)
    o = await owner({ version: '1.0.0', updateUrl: broken.url })
    assert.match(String((await o.h.request('GET', '/api/admin/update', { token: o.token })).body['error']), /Could not check: the release feed answered 500/)
    o = await owner({ version: '1.0.0', updateUrl: sneaky.url })
    assert.equal((await o.h.request('GET', '/api/admin/update', { token: o.token })).body['url'], null)
  } finally {
    none.server.close(); broken.server.close(); sneaky.server.close()
  }
})

test('turned off: nothing is fetched, and only staff may ask', async () => {
  const { h, token, user } = await owner({ version: '1.0.0' })
  const res = await h.request('GET', '/api/admin/update', { token })
  assert.equal(res.body['enabled'], false)
  assert.equal(res.body['latest'], null)
  assert.equal((await h.request('GET', '/api/admin/update', { token: user })).status, 403)
})
