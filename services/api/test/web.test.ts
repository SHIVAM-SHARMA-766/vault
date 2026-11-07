// The server's own static serving must behave exactly like the Caddyfile:
// same headers, same routing, same caching, nothing outside its roots.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

import { SECURITY_HEADERS, headersFor, serveStatic } from '../src/web.js'

test('the security headers are the Caddyfile\'s, word for word', () => {
  const caddy = readFileSync(join(process.cwd(), '../../apps/web/Caddyfile'), 'utf8')
  const block = caddy.slice(caddy.indexOf('(security_headers)'), caddy.indexOf('-Server'))
  const fromCaddy = Object.fromEntries([...block.matchAll(/^\s*([A-Z][A-Za-z-]+) "([^"]+)"$/gm)].map((m) => [m[1], m[2]]))
  assert.deepEqual(fromCaddy, SECURITY_HEADERS)
})

test('over plain http (local development), HSTS and the upgrade directive are left out', () => {
  const h = headersFor('http://localhost:8080')
  assert.equal(h['Strict-Transport-Security'], undefined)
  assert.ok(!h['Content-Security-Policy']!.includes('upgrade-insecure-requests'))
  assert.equal(headersFor('https://v.example')['Strict-Transport-Security'], SECURITY_HEADERS['Strict-Transport-Security'])
})

async function serve() {
  const root = mkdtempSync(join(tmpdir(), 'vault-web-'))
  const web = join(root, 'web'); const site = join(root, 'site')
  mkdirSync(join(web, 'assets'), { recursive: true }); mkdirSync(join(site, 'current'), { recursive: true }); mkdirSync(join(site, 'media'))
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>shell</title>')
  writeFileSync(join(web, 'assets', 'app-abc123.js'), 'console.log(1)'.repeat(50))
  writeFileSync(join(site, 'current', 'index.html'), 'home')
  writeFileSync(join(site, 'current', 'security.html'), 'security')
  writeFileSync(join(site, 'current', '404.html'), 'not here')
  writeFileSync(join(site, 'media', 'm_abc.png'), 'png')
  writeFileSync(join(root, 'secret.txt'), 'do not serve')
  const server = createServer((req, res) => serveStatic(req, res, { web, site, origin: 'https://v.example' }))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const get = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(base + path, { redirect: 'manual', ...init })
    return { status: res.status, headers: res.headers, text: init.method === 'HEAD' ? '' : await res.text() }
  }
  return { get, done: () => { server.close(); rmSync(root, { recursive: true, force: true }) } }
}

test('routes like the Caddyfile: shell for client routes, 404 for missing assets, site pages by name', async () => {
  const { get, done } = await serve()
  try {
    assert.equal((await get('/app')).headers.get('location'), '/app/')
    for (const p of ['/app/', '/app/settings', '/app/admin/users']) {
      const r = await get(p)
      assert.equal(r.status, 200, p); assert.match(r.text, /shell/); assert.equal(r.headers.get('cache-control'), 'no-store')
    }
    const missing = await get('/app/assets/gone-123.js')
    assert.equal(missing.status, 404); assert.equal(missing.text, 'not here')
    const asset = await get('/app/assets/app-abc123.js')
    assert.equal(asset.status, 200); assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable')
    assert.equal((await get('/')).text, 'home')
    assert.equal((await get('/security')).text, 'security')
    assert.equal((await get('/nope')).status, 404)
    assert.equal((await get('/media/m_abc.png')).status, 200)
    assert.equal((await get('/media/m_abc.svg')).status, 404, 'only the three raster types')
    assert.equal((await get('/', { method: 'POST' })).status, 405)
  } finally { done() }
})

test('every response carries the security headers, and nothing outside the roots is reachable', async () => {
  const { get, done } = await serve()
  try {
    for (const p of ['/', '/app/', '/nope', '/app/assets/app-abc123.js']) {
      const r = await get(p)
      assert.equal(r.headers.get('content-security-policy'), SECURITY_HEADERS['Content-Security-Policy'], p)
      assert.equal(r.headers.get('x-frame-options'), 'DENY', p)
    }
    for (const p of ['/app/../secret.txt', '/app/%2e%2e/secret.txt', '/%2e%2e/secret.txt', '/media/..%2fsecret.txt']) {
      const r = await get(p)
      assert.notEqual(r.text, 'do not serve', p)
    }
  } finally { done() }
})

test('text is gzipped when the client accepts it', async () => {
  const { done } = await serve()
  done()
  const root = mkdtempSync(join(tmpdir(), 'vault-web-'))
  try {
    mkdirSync(join(root, 'web/assets'), { recursive: true }); mkdirSync(join(root, 'site/current'), { recursive: true })
    writeFileSync(join(root, 'web/assets/a.js'), 'x'.repeat(5000))
    const server = createServer((req, res) => serveStatic(req, res, { web: join(root, 'web'), site: join(root, 'site'), origin: 'https://v.example' }))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const { port } = server.address() as AddressInfo
    const raw = await new Promise<{ enc: string | undefined; body: Buffer }>((resolve) => {
      import('node:http').then(({ get }) => get({ port, path: '/app/assets/a.js', headers: { 'accept-encoding': 'gzip' } }, (res) => {
        const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => resolve({ enc: res.headers['content-encoding'], body: Buffer.concat(chunks) }))
      }))
    })
    server.close()
    assert.equal(raw.enc, 'gzip')
    assert.equal(gunzipSync(raw.body).toString(), 'x'.repeat(5000))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
