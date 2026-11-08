// The guard on requests to addresses a person typed (personal backups): no
// reaching the server's own network, no plain http, no redirects.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { EgressRefused, checkDestinationUrl, guardedRequest, isBlockedAddress } from '../src/egress.js'

test('loopback, private, link-local, CGNAT, multicast and reserved addresses are blocked', () => {
  for (const a of ['127.0.0.1', '127.8.8.8', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fd00::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', 'not-an-ip']) {
    assert.equal(isBlockedAddress(a), true, a)
  }
})

test('public addresses are allowed', () => {
  for (const a of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isBlockedAddress(a), false, a)
  }
})

test('a destination must be https, carry no credentials, and not be a private literal', () => {
  assert.throws(() => checkDestinationUrl('http://example.com/dav', false), EgressRefused)
  assert.throws(() => checkDestinationUrl('ftp://example.com/', false), EgressRefused)
  assert.throws(() => checkDestinationUrl('https://user:pw@example.com/', false), EgressRefused)
  assert.throws(() => checkDestinationUrl('https://169.254.169.254/latest/', false), EgressRefused)
  assert.throws(() => checkDestinationUrl('https://[::1]/', false), EgressRefused)
  assert.throws(() => checkDestinationUrl('not a url', false), EgressRefused)
  assert.equal(checkDestinationUrl('https://dav.example.com/remote.php/dav/files/me/', false).hostname, 'dav.example.com')
})

test('with private destinations allowed, http and LAN addresses are accepted', () => {
  assert.equal(checkDestinationUrl('http://192.168.1.10:8080/dav', true).port, '8080')
})

async function local(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; url: string }> {
  const server = createServer(handler)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

test('a name that resolves to loopback is refused at connection time', async () => {
  await assert.rejects(guardedRequest('https://localhost:1/x', { allowPrivate: false }), (e: Error) => e instanceof EgressRefused || /private or reserved/.test(e.message))
})

test('allowed private destinations are reached, and redirects are not followed', async () => {
  let hits = 0
  const { server, url } = await local((req, res) => {
    hits++
    if (req.url === '/moved') { res.writeHead(302, { location: 'http://169.254.169.254/' }); res.end(); return }
    res.end('hello')
  })
  try {
    const ok = await guardedRequest(`${url}/x`, { allowPrivate: true })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.toString(), 'hello')
    const moved = await guardedRequest(`${url}/moved`, { allowPrivate: true })
    assert.equal(moved.status, 302)
    assert.equal(hits, 2, 'the redirect target was never requested')
  } finally {
    server.close()
  }
})

test('responses larger than the cap are cut off', async () => {
  const { server, url } = await local((_req, res) => { res.end(Buffer.alloc(4096, 1)) })
  try {
    await assert.rejects(guardedRequest(`${url}/big`, { allowPrivate: true, maxResponseBytes: 1024 }), /too large/)
  } finally {
    server.close()
  }
})
