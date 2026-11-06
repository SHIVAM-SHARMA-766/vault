// The OpenAPI document, request ids, and the error body every client relies on.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildRouter } from '../src/app.js'
import { ERROR_CODES } from '../src/http.js'
import { openapi } from '../src/openapi.js'
import { MemoryStore } from '../src/store-memory.js'
import { harness } from './harness.js'

const router = buildRouter({ store: new MemoryStore(), config: {} as never, now: Date.now, allowRegistration: false, adminDigests: new Set() })

test('every route has a summary, and staff routes name their permission', () => {
  for (const r of router.list()) {
    assert.ok(r.summary, `${r.method} ${r.path} has no summary`)
    if (r.path.startsWith('/api/admin')) {
      assert.equal(r.auth, 'access', `${r.path} needs a session`)
      assert.ok(r.permission, `${r.path} names no permission`)
    }
  }
  const vault = router.list().find((r) => r.path === '/api/vault')!
  assert.equal(vault.auth, 'access')
  assert.equal(router.list().find((r) => r.path === '/api/auth/login')!.auth, 'none')
})

test('docs/openapi.json is up to date (npm run openapi --workspace @vault/api)', () => {
  const committed = JSON.parse(readFileSync(join(process.cwd(), '../../docs/openapi.json'), 'utf8'))
  assert.deepEqual(committed, JSON.parse(JSON.stringify(openapi(router))))
})

test('the document is served, and lists every error code', async () => {
  const h = harness()
  const res = await h.request('GET', '/api/openapi.json')
  assert.equal(res.status, 200)
  const schema = (res.body['components'] as any).schemas.Error.properties.error
  assert.deepEqual(schema.enum, Object.keys(ERROR_CODES))
  assert.ok((res.body['paths'] as any)['/api/vault/entries/{id}'].put.security[0].bearer)
})

test('every response carries a request id, and errors repeat it in the body', async () => {
  const h = harness()
  const ok = await h.request('GET', '/api/health')
  assert.match(ok.headers['x-request-id'] ?? '', /^[0-9a-f-]{36}$/)
  const missing = await h.request('GET', '/api/no-such-route')
  assert.equal(missing.status, 404)
  assert.equal(missing.body['error'], 'not_found')
  assert.equal(missing.body['requestId'], missing.headers['x-request-id'])
  // A plausible id from the proxy is kept; a hostile one is replaced.
  assert.equal((await h.request('GET', '/api/health', { rawHeaders: { 'x-request-id': 'caddy-1234abcd' } })).headers['x-request-id'], 'caddy-1234abcd')
  assert.notEqual((await h.request('GET', '/api/health', { rawHeaders: { 'x-request-id': 'bad id\n{"x":1}' } })).headers['x-request-id'], 'bad id\n{"x":1}')
})
