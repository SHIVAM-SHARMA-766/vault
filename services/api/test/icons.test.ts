// Website icons (design refresh): only raster images pass, a page's declared
// icons are ranked, and the route answers from its cache without a sign-in.

import test from 'node:test'
import assert from 'node:assert/strict'

import { iconLinks, sniff } from '../src/routes/icons.js'
import { harness } from './harness.js'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

test('only raster images are accepted, judged by their bytes', () => {
  assert.equal(sniff(PNG), 'image/png')
  assert.equal(sniff(Buffer.from([0, 0, 1, 0, 1, 0])), 'image/x-icon')
  assert.equal(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
  assert.equal(sniff(Buffer.from('GIF89a......')), 'image/gif')
  assert.equal(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), null, 'never SVG')
  assert.equal(sniff(Buffer.from('<!doctype html><html>')), null)
})

test('a page\'s icons: apple-touch first, then larger sizes; SVG and plain http left out', () => {
  const html = `<head>
    <link rel="icon" href="/favicon-16.png" sizes="16x16">
    <link rel="icon" type="image/svg+xml" href="/icon.svg">
    <link rel="apple-touch-icon" href="https://cdn.example.com/touch.png">
    <link rel="shortcut icon" href="/favicon-64.png" sizes="64x64">
    <link rel="icon" href="http://insecure.example.com/x.png">
    <link rel="stylesheet" href="/app.css">
  </head>`
  assert.deepEqual(iconLinks(html, 'https://example.com/'), [
    'https://cdn.example.com/touch.png', 'https://example.com/favicon-64.png', 'https://example.com/favicon-16.png',
  ])
})

test('the route needs no sign-in, refuses odd hosts, and serves from its cache with safe headers', async () => {
  const h = harness()
  assert.equal((await h.request('GET', '/api/icons/127.0.0.1')).status, 404, 'an address is not a host')
  assert.equal((await h.request('GET', '/api/icons/localhost')).status, 404)
  assert.equal((await h.request('GET', '/api/icons/..%2Fetc')).status, 404)
  await h.app.store.put({ pk: 'ICON', sk: 'example.com', type: 'image/png', data: PNG.toString('base64'), expiresAt: Math.floor(h.app.now() / 1000) + 3600 })
  const res = await h.request('GET', '/api/icons/www.example.com')
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-type'], 'image/png')
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  assert.match(res.headers['cache-control'] ?? '', /max-age=604800/)
  assert.equal(Buffer.from(res.raw, 'base64').subarray(0, 8).toString('hex'), PNG.subarray(0, 8).toString('hex'))
  await h.app.store.put({ pk: 'ICON', sk: 'nothing.example', missing: true, expiresAt: Math.floor(h.app.now() / 1000) + 3600 })
  assert.equal((await h.request('GET', '/api/icons/nothing.example')).status, 404, 'a remembered miss')
})
