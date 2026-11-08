// The breach check relay (D5): only a 5-character prefix reaches the server,
// which fetches the padded range and returns it; off means off.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'

import { clearBreachCache } from '../src/breach.js'
import { harness, registration } from './harness.js'

async function upstream() {
  const seen: IncomingMessage[] = []
  const server = createServer((req, res) => {
    seen.push(req)
    if (req.url === '/range/FFFFF') { res.writeHead(503); res.end(); return }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('011053FD0102E94D6AE2F8B83D76FAF94F6:12\r\n00D4F6E8FA6EECAD2A3AA415EEC418D38EC:0\r\n')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/range/`
  return { url, seen, close: () => new Promise<void>((r) => server.close(() => r())) }
}

async function signedIn(breachUrl?: string) {
  const h = harness({ allowRegistration: true, ...(breachUrl ? { breachUrl } : {}) })
  const token = String((await h.request('POST', '/api/auth/register', { body: registration() })).body['accessToken'])
  return { h, token }
}

test('a prefix is relayed with padding asked for, and the range comes back', async () => {
  clearBreachCache()
  const up = await upstream()
  try {
    const { h, token } = await signedIn(up.url)
    const res = await h.request('GET', '/api/breach/range/21bd1', { token })
    assert.equal(res.status, 200)
    assert.match(String(res.body['range']), /011053FD0102E94D6AE2F8B83D76FAF94F6:12/)
    assert.equal(up.seen[0]!.url, '/range/21BD1', 'upper-cased, and only the prefix')
    assert.equal(up.seen[0]!.headers['add-padding'], 'true')
    await h.request('GET', '/api/breach/range/21BD1', { token })
    assert.equal(up.seen.length, 1, 'cached')
  } finally { await up.close() }
})

test('only five hex characters are accepted, only from a signed-in account', async () => {
  const up = await upstream()
  try {
    const { h, token } = await signedIn(up.url)
    for (const bad of ['21BD', '21BD12', 'GGGGG', '..%2F..']) assert.equal((await h.request('GET', `/api/breach/range/${bad}`, { token })).status, 400, bad)
    assert.equal((await h.request('GET', '/api/breach/range/21BD1')).status, 401)
    assert.equal(up.seen.length, 0)
  } finally { await up.close() }
})

test('an upstream failure is a 502 with a plain message', async () => {
  const up = await upstream()
  try {
    const { h, token } = await signedIn(up.url)
    const res = await h.request('GET', '/api/breach/range/FFFFF', { token })
    assert.equal(res.status, 502)
    assert.match(String(res.body['message']), /could not be reached/)
  } finally { await up.close() }
})

test('turned off, nothing is relayed and the instance says so', async () => {
  const { h, token } = await signedIn()
  assert.equal((await h.request('GET', '/api/breach/range/21BD1', { token })).status, 503)
  assert.equal((await h.request('GET', '/api/instance')).body['breachCheck'], false)
})
