// Personal backups to Google Drive and OneDrive (decisions/0024), against a
// mock of both providers: connecting with OAuth and PKCE, the narrow scopes,
// uploads (Drive's resumable upload, OneDrive's chunked session for large
// files), test restore, pruning, Microsoft's rotating refresh tokens, and
// nothing offered when the operator registered no app.

import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { ENTRY_PREFIX, userPk } from '../src/keys.js'
import { harness, registration } from './harness.js'

interface Mock {
  base: string
  files: Map<string, { name: string; parent?: string; body: Buffer }>
  refresh: { google: Set<string>; ms: Set<string> }
  chunks: number
  close(): Promise<void>
}

async function mockProviders(): Promise<Mock> {
  const codes = new Map<string, { challenge: string; who: 'google' | 'ms' }>()
  const files = new Map<string, { name: string; parent?: string; body: Buffer }>()
  const sessions = new Map<string, { name: string; parent?: string; parts: Buffer[] }>()
  const refresh = { google: new Set<string>(), ms: new Set<string>() }
  let n = 0
  const m: Mock = { base: '', files, refresh, chunks: 0, close: () => new Promise((r) => server.close(() => r())) }
  const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.y`
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', m.base)
    const parts: Buffer[] = []
    req.on('data', (d: Buffer) => parts.push(d))
    req.on('end', () => {
      const body = Buffer.concat(parts)
      const send = (status: number, value: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(value === undefined ? '' : JSON.stringify(value)) }
      const bearer = req.headers.authorization === 'Bearer access-ok'
      // Token endpoints.
      if (url.pathname === '/g/token' || url.pathname === '/m/token') {
        const who = url.pathname === '/g/token' ? 'google' : 'ms'
        const f = new URLSearchParams(body.toString())
        if (f.get('grant_type') === 'authorization_code') {
          const c = codes.get(f.get('code') ?? '')
          if (!c || createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url') !== c.challenge) return send(400, { error: 'invalid_grant' })
          const rt = `rt-${who}-${++n}`; refresh[who].add(rt)
          return send(200, { access_token: 'access-ok', refresh_token: rt, id_token: idToken(`${who}@example.com`) })
        }
        const rt = f.get('refresh_token') ?? ''
        if (!refresh[who].has(rt)) return send(400, { error: 'invalid_grant' })
        if (who === 'ms') { refresh.ms.delete(rt); const next = `rt-ms-${++n}`; refresh.ms.add(next); return send(200, { access_token: 'access-ok', refresh_token: next }) }
        return send(200, { access_token: 'access-ok' })
      }
      // The consent page: the test plays the person and approves at once.
      if (url.pathname === '/g/auth' || url.pathname === '/m/auth') {
        const code = `code-${++n}`
        codes.set(code, { challenge: url.searchParams.get('code_challenge')!, who: url.pathname === '/g/auth' ? 'google' : 'ms' })
        const back = new URL(url.searchParams.get('redirect_uri')!)
        back.searchParams.set('code', code); back.searchParams.set('state', url.searchParams.get('state')!)
        res.writeHead(302, { location: back.toString() }); return res.end()
      }
      // Google Drive.
      if (url.pathname === '/gapi/drive/v3/files' && req.method === 'POST') {
        if (!bearer) return send(401, {})
        const id = `folder-${++n}`; files.set(id, { name: JSON.parse(body.toString()).name, body: Buffer.alloc(0) }); return send(200, { id })
      }
      if (url.pathname === '/gapi/upload/drive/v3/files' && url.searchParams.get('uploadType') === 'resumable') {
        if (!bearer) return send(401, {})
        const meta = JSON.parse(body.toString()) as { name: string; parents: string[] }
        const sid = `s${++n}`; sessions.set(sid, { name: meta.name, ...(meta.parents[0] ? { parent: meta.parents[0] } : {}), parts: [] })
        return send(200, {}, { location: `${m.base}/gapi/session/${sid}` })
      }
      if (url.pathname.startsWith('/gapi/session/') && req.method === 'PUT') {
        const s = sessions.get(url.pathname.split('/').pop()!)!
        const id = `file-${++n}`; files.set(id, { name: s.name, ...(s.parent ? { parent: s.parent } : {}), body }); return send(200, { id })
      }
      const g = url.pathname.match(/^\/gapi\/drive\/v3\/files\/(.+)$/)
      if (g) {
        if (!bearer) return send(401, {})
        const f = files.get(decodeURIComponent(g[1]!))
        if (!f) return send(404, {})
        if (req.method === 'DELETE') { files.delete(decodeURIComponent(g[1]!)); res.writeHead(204); return res.end() }
        res.writeHead(200, { 'content-type': 'application/json' }); return res.end(f.body)
      }
      // Microsoft Graph, app folder.
      const o = url.pathname.match(/^\/graph\/v1\.0\/me\/drive\/special\/approot:\/([^:]+):?(\/content|\/createUploadSession)?$/)
      if (o) {
        const name = decodeURIComponent(o[1]!)
        if (!bearer) return send(401, {})
        if (o[2] === '/content' && req.method === 'PUT') { files.set(`od:${name}`, { name, body }); return send(201, { id: `od-${name}` }) }
        if (o[2] === '/content' && req.method === 'GET') { const f = files.get(`od:${name}`); if (!f) return send(404, {}); res.writeHead(200); return res.end(f.body) }
        if (o[2] === '/createUploadSession') { const sid = `u${++n}`; sessions.set(sid, { name, parts: [] }); return send(200, { uploadUrl: `${m.base}/upload/${sid}` }) }
        if (!o[2] && req.method === 'DELETE') { files.delete(`od:${name}`); res.writeHead(204); return res.end() }
      }
      if (url.pathname.startsWith('/upload/') && req.method === 'PUT') {
        if (req.headers.authorization) return send(400, { error: 'the upload URL must not get a bearer token' })
        const s = sessions.get(url.pathname.split('/').pop()!)!
        const [, a, b, total] = String(req.headers['content-range']).match(/bytes (\d+)-(\d+)\/(\d+)/)!.map(Number) as [number, number, number, number]
        assert.equal(b - a + 1, body.length)
        m.chunks++
        s.parts.push(body)
        if (b + 1 < total) return send(202, { nextExpectedRanges: [`${b + 1}-`] })
        files.set(`od:${s.name}`, { name: s.name, body: Buffer.concat(s.parts) })
        return send(201, { id: `od-${s.name}` })
      }
      send(404, {})
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  m.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return m
}

let mocks: Mock[] = []
afterEach(async () => { await Promise.all(mocks.map((m) => m.close())); mocks = [] })

async function setup() {
  const m = await mockProviders(); mocks.push(m)
  const h = harness({
    allowRegistration: true, remoteBackups: true,
    cloudDrive: {
      google: { clientId: 'g-client', clientSecret: 'g-secret' }, microsoft: { clientId: 'm-client', clientSecret: 'm-secret' },
      endpoints: { googleAuth: `${m.base}/g/auth`, googleToken: `${m.base}/g/token`, googleApi: `${m.base}/gapi`, msAuth: `${m.base}/m/auth`, msToken: `${m.base}/m/token`, msGraph: `${m.base}/graph` },
    },
  })
  const reg = (await h.request('POST', '/api/auth/register', { body: registration({ email: 'me@example.com' }) })).body
  return { h, m, token: String(reg['accessToken']), userId: String(reg['userId']) }
}

/** Connect: Vault's consent URL, the provider approving, Vault's callback. */
async function connect(h: ReturnType<typeof harness>, token: string, provider: 'gdrive' | 'onedrive') {
  const r = await h.request('POST', `/api/backups/connect/${provider}`, { token })
  assert.equal(r.status, 200)
  const consent = new URL(String(r.body['url']))
  const approved = await fetch(consent, { redirect: 'manual' })
  const cb = new URL(approved.headers.get('location')!)
  const res = await h.request('GET', `/api/backups/oauth/callback${cb.search}`)
  assert.equal(res.status, 302)
  return { consent, back: new URL(res.headers['location']!) }
}

const SCHEDULE = { frequency: 'daily', hour: 2, weekday: 0, tzOffsetMinutes: 0, keep: 2 }

test('Google Drive: narrow scope, offline access, PKCE; backups go to its folder, open again, and are pruned', async () => {
  const { h, m, token } = await setup()
  assert.deepEqual((await h.request('GET', '/api/backups', { token })).body['cloud'], { gdrive: true, onedrive: true })
  const { consent, back } = await connect(h, token, 'gdrive')
  assert.equal(consent.searchParams.get('scope'), 'openid email https://www.googleapis.com/auth/drive.file')
  assert.equal(consent.searchParams.get('access_type'), 'offline')
  assert.equal(consent.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(consent.searchParams.get('redirect_uri'), 'https://vault.test/api/backups/oauth/callback')
  assert.equal(`${back.pathname}${back.hash}`, '/app/settings/backups#cloud=gdrive')

  const state = (await h.request('GET', '/api/backups', { token })).body
  assert.deepEqual(state['destination'], { type: 'gdrive', account: 'google@example.com', hasSecret: true })
  assert.equal(JSON.stringify(state).includes('rt-google'), false, 'the refresh token never leaves the server')
  const folder = [...m.files.entries()].find(([, f]) => f.name === 'Vault backups')![0]

  // Keep two, with the schedule saved alongside the connected drive.
  assert.equal((await h.request('PUT', '/api/backups/config', { token, body: { schedule: SCHEDULE, destination: { type: 'gdrive' } } })).status, 200)
  for (let i = 0; i < 3; i++) {
    h.setNow(Date.UTC(2026, 8, 22, 12, i, 0))
    const run = await h.request('POST', '/api/backups/run', { token })
    assert.equal(run.status, 200, JSON.stringify(run.body))
  }
  const backups = [...m.files.values()].filter((f) => f.parent === folder)
  assert.equal(backups.length, 2, 'the oldest was deleted')
  const latest = await h.request('GET', '/api/backups/latest', { token })
  assert.equal(latest.status, 200)
  assert.equal(JSON.parse(String(latest.body['body'])).format, 'vault-personal-backup')
  assert.equal((await h.request('GET', '/api/backups', { token })).body['runs'] instanceof Array, true)
})

test('OneDrive: app folder, a large file in chunks without the bearer token, and rotating refresh tokens', async () => {
  const { h, m, token, userId } = await setup()
  const { consent } = await connect(h, token, 'onedrive')
  assert.equal(consent.searchParams.get('scope'), 'openid email offline_access Files.ReadWrite.AppFolder')
  // About 5 MB of (pretend) ciphertext: more than one PUT may carry.
  for (let i = 0; i < 14; i++) await h.store.put({ pk: userPk(userId), sk: `${ENTRY_PREFIX}e${i}`, id: `e${i}`, blob: `v1.${'A'.repeat(16)}.${'B'.repeat(370_000)}` })
  const first = await h.request('POST', '/api/backups/run', { token })
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.ok(m.chunks >= 2, 'uploaded in chunks')
  const stored = [...m.files.values()].find((f) => f.name.startsWith('vault-backup-'))!
  assert.ok(stored.body.length > 4 * 1024 * 1024)
  // Microsoft handed out a new refresh token; the old one is dead, and the
  // next run must use the new one.
  assert.equal(m.refresh.ms.size, 1)
  h.setNow(Date.UTC(2026, 8, 22, 12, 5, 0))
  assert.equal((await h.request('POST', '/api/backups/run', { token })).status, 200)
  const latest = await h.request('GET', '/api/backups/latest', { token })
  assert.equal(latest.status, 200)
  assert.equal(JSON.parse(String(latest.body['body'])).entries.length, 14)
})

test('a refused consent, a stale state, or a revoked token are explained; nothing without the operator\'s app', async () => {
  const { h, m, token } = await setup()
  const denied = await h.request('GET', '/api/backups/oauth/callback?error=access_denied&state=x')
  assert.match(decodeURIComponent(new URL(denied.headers['location']!).hash), /You did not allow Vault access/)
  const stale = await h.request('GET', '/api/backups/oauth/callback?code=c&state=nope')
  assert.match(decodeURIComponent(new URL(stale.headers['location']!).hash), /cloud-error=That took too long/)

  await connect(h, token, 'gdrive')
  m.refresh.google.clear() // the person removed Vault's access at Google
  const run = await h.request('POST', '/api/backups/run', { token })
  assert.equal(run.status, 502)
  assert.match(String(run.body['message']), /no longer accepts Vault's access/)

  // Choosing a drive that was never connected is refused.
  assert.equal((await h.request('PUT', '/api/backups/config', { token, body: { schedule: SCHEDULE, destination: { type: 'onedrive' } } })).status, 400)

  const plain = harness({ allowRegistration: true, remoteBackups: true })
  const t2 = String((await plain.request('POST', '/api/auth/register', { body: registration({ email: 'x@example.com' }) })).body['accessToken'])
  assert.deepEqual((await plain.request('GET', '/api/backups', { token: t2 })).body['cloud'], { gdrive: false, onedrive: false })
  assert.equal((await plain.request('POST', '/api/backups/connect/gdrive', { token: t2 })).status, 404)
  assert.equal((await plain.request('PUT', '/api/backups/config', { token: t2, body: { schedule: SCHEDULE, destination: { type: 'gdrive' } } })).status, 400)
})
