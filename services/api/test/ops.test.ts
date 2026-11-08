// Operations for an organization running Vault: Prometheus metrics behind a
// token (B6), the audit log as a file and as a signed stream (B7).

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'

import { fixtureB64, harness, registration, sealedBlob } from './harness.js'

const TOKEN = 'm'.repeat(40)

async function setup(opts: Parameters<typeof harness>[0] = {}) {
  const h = harness({ adminEmails: ['owner@example.com'], allowRegistration: true, metricsToken: TOKEN, ...opts })
  const owner = String((await h.request('POST', '/api/auth/register', { body: registration({ email: 'owner@example.com', authKey: fixtureB64('owner') }) })).body['accessToken'])
  const user = String((await h.request('POST', '/api/auth/register', { body: registration({ email: 'user@example.com', authKey: fixtureB64('user') }) })).body['accessToken'])
  return { h, owner, user }
}

test('metrics are off without a token, refused with a wrong one, and counts-only with the right one', async () => {
  const off = harness()
  assert.equal((await off.request('GET', '/api/metrics')).status, 404)

  const { h, user } = await setup()
  await h.request('PUT', `/api/vault/entries/${crypto.randomUUID()}`, { token: user, body: { blob: sealedBlob('e1') } })
  assert.equal((await h.request('GET', '/api/metrics')).status, 401)
  assert.equal((await h.request('GET', '/api/metrics', { rawHeaders: { authorization: `Bearer ${'x'.repeat(40)}` } })).status, 401)

  const { dispatch } = await import('../src/app.js')
  const res = await dispatch(h.app, { rawPath: '/api/metrics', headers: { authorization: `Bearer ${TOKEN}` }, requestContext: { http: { method: 'GET', sourceIp: '203.0.113.7', userAgent: 't' } } })
  assert.equal(res.statusCode, 200)
  assert.match(String(res.headers['content-type']), /text\/plain/)
})

test('the metrics text has the expected series and no addresses', async () => {
  const { h, user } = await setup()
  await h.request('PUT', `/api/vault/entries/${crypto.randomUUID()}`, { token: user, body: { blob: sealedBlob('e1') } })
  const { dispatch } = await import('../src/app.js')
  const raw = await dispatch(h.app, { rawPath: '/api/metrics', headers: { authorization: `Bearer ${TOKEN}` }, requestContext: { http: { method: 'GET', sourceIp: '203.0.113.7', userAgent: 't' } } })
  const body = String(raw.body)
  assert.match(body, /^# HELP vault_info/m)
  assert.match(body, /vault_accounts\{state="active"\} 2/)
  assert.match(body, /vault_items 1/)
  assert.match(body, /vault_sessions 2/)
  assert.match(body, /vault_http_requests_total\{method="PUT",status="2xx"\} \d+/)
  assert.ok(!body.includes('example.com'), 'no addresses')
})

test('the audit log downloads as CSV (formula-safe) and JSON, for staff only', async () => {
  const { h, owner, user } = await setup()
  const userId = String((await h.request('GET', '/api/auth/me', { token: user })).body['userId'])
  await h.request('PUT', `/api/admin/users/${userId}/label`, { token: owner, body: { label: '=HYPERLINK("http://x")' } })
  await h.request('PUT', '/api/admin/settings', { token: owner, body: { registration: 'invite' } })
  const { dispatch } = await import('../src/app.js')
  const ev = (q: string, token: string) => ({ rawPath: '/api/admin/audit/export', rawQueryString: q, headers: { 'x-vault-auth': `Bearer ${token}` }, requestContext: { http: { method: 'GET', sourceIp: '203.0.113.7', userAgent: 't' } } })
  const csv = await dispatch(h.app, ev('format=csv', owner))
  assert.equal(csv.statusCode, 200)
  assert.match(String(csv.headers['content-disposition']), /vault-audit-\d{4}-\d{2}-\d{2}\.csv/)
  const text = String(csv.body)
  assert.match(text.split('\r\n')[0]!, /^at,actor,actorLabel,action,target,targetLabel,detail$/)
  assert.match(text, /settings\.registration/)
  assert.match(text, /"'=HYPERLINK/, 'a label that looks like a formula is neutralised')
  const json = await dispatch(h.app, ev('format=json', owner))
  const parsed = JSON.parse(String(json.body)) as { records: { action: string }[] }
  assert.ok(parsed.records.some((r) => r.action === 'user.label'))
  assert.equal((await dispatch(h.app, ev('', user))).statusCode, 403)
})

test('audit and organization events stream to the webhook, signed', async () => {
  const got: { body: string; sig: string | undefined }[] = []
  const server = createServer((req: IncomingMessage, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => { got.push({ body, sig: req.headers['x-vault-signature'] as string | undefined }); res.end('ok') })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`
    const { h, owner } = await setup({ auditWebhook: url, auditSecret: 'shh-secret' })
    await h.request('PUT', '/api/admin/settings', { token: owner, body: { registration: 'invite' } })
    for (let i = 0; i < 50 && !got.length; i++) await new Promise((r) => setTimeout(r, 20))
    assert.ok(got.length >= 1)
    const e = JSON.parse(got[0]!.body) as { source: string; action: string; service: string }
    assert.deepEqual([e.service, e.source, e.action], ['vault', 'admin', 'settings.registration'])
    assert.equal(got[0]!.sig, `sha256=${createHmac('sha256', 'shh-secret').update(got[0]!.body).digest('hex')}`)
  } finally { server.close() }
})
