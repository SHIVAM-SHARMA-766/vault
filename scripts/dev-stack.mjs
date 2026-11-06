#!/usr/bin/env node
// The whole product on one local port, with no database and no cloud account.
//
//   npm run build && npm run dev:stack            # then open http://localhost:8080
//   PORT=9000 OWNER_EMAIL=me@example.test npm run dev:stack
//
// It serves the same three things Caddy serves, the same way:
//
//   /api/*     the real router (services/api), over an in-memory store
//   /app/*     the built client, with the single-page fallback
//   /          the public site, rendered by the API from its templates
//   /media/*   images uploaded from the admin panel
//
// with the Content-Security-Policy read from apps/web/Caddyfile, so anything
// that would break in production breaks here too. Data lives only in memory
// and is gone when the process stops.
//
// The browser tests (tests/e2e) start one of these per run.

import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('../', import.meta.url).pathname
const API = join(ROOT, 'services/api/dist/src')
const need = (p, hint) => { try { statSync(p) } catch { console.error(`missing ${p} — ${hint}`); process.exit(1) } }
need(join(API, 'app.js'), 'run `npm run build` first')
need(join(ROOT, 'apps/web/dist/index.html'), 'run `npm run build` first')

const { buildRouter, handleRequest } = await import(join(API, 'app.js'))
const { MemoryStore } = await import(join(API, 'store-memory.js'))
const { emailDigest } = await import(join(API, 'identity.js'))
const { publishToDisk } = await import(join(API, 'site.js'))

const PORT = Number(process.env.PORT ?? 8080)
const OWNER = process.env.OWNER_EMAIL ?? 'owner@example.test'
const PEPPER = 'dev-stack-pepper-not-a-secret-0000000000'
const CSP = readFileSync(join(ROOT, 'apps/web/Caddyfile'), 'utf8').match(/Content-Security-Policy "([^"]+)"/)?.[1]
if (!CSP) { console.error('could not read the Content-Security-Policy from apps/web/Caddyfile'); process.exit(1) }

const app = {
  store: new MemoryStore(),
  now: () => Date.now(),
  // Open so the first account can be made; the admin panel can close it, and
  // POST /__dev/registration?open=0 does the same from a test.
  allowRegistration: process.env.REGISTRATION !== 'closed',
  adminDigests: new Set([emailDigest(OWNER, PEPPER)]),
  site: { sourceDir: join(ROOT, 'apps/site'), outputDir: mkdtempSync(join(tmpdir(), 'vault-dev-site-')), origin: `http://localhost:${PORT}` },
  config: {
    port: PORT, origin: `http://localhost:${PORT}`, allowRegistration: true, adminEmails: [OWNER],
    site: { sourceDir: '', outputDir: '' },
    db: { host: 'memory', user: 'dev', password: 'dev', database: 'dev', port: 0 },
    pepper: PEPPER, tokenKey: 'dev-stack-token-key-not-a-secret-000000',
  },
}
const router = buildRouter(app)
await publishToDisk(app, app.site)

const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', map: 'application/json', txt: 'text/plain' }
const isFile = (p) => { try { return statSync(p).isFile() } catch { return false } }
const WEB = join(ROOT, 'apps/web/dist')
const SITE = () => join(app.site.outputDir, 'current')

function send(res, status, file) {
  res.writeHead(status, {
    'content-type': TYPES[file.split('.').pop()] ?? 'application/octet-stream',
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  })
  res.end(readFileSync(file))
}

createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', async () => {
    const url = new URL(req.url ?? '/', 'http://local')
    const p = decodeURIComponent(url.pathname)
    if (p.includes('..')) { res.writeHead(400); return res.end() }

    if (p === '/__dev/registration' && req.method === 'POST') {
      app.allowRegistration = url.searchParams.get('open') === '1'
      return res.end(JSON.stringify({ open: app.allowRegistration }))
    }

    if (p.startsWith('/api/')) {
      const r = await handleRequest(router, {
        rawPath: p, rawQueryString: url.search.slice(1), headers: req.headers,
        ...(chunks.length ? { body: Buffer.concat(chunks).toString('utf8') } : {}),
        requestContext: { http: { method: req.method ?? 'GET', sourceIp: '127.0.0.1', userAgent: String(req.headers['user-agent'] ?? '') } },
      })
      res.writeHead(r.statusCode, r.headers)
      return res.end(r.body)
    }

    if (p === '/app') { res.writeHead(308, { location: '/app/' }); return res.end() }
    if (p.startsWith('/app/')) {
      const file = join(WEB, p.slice('/app/'.length) || 'index.html')
      if (isFile(file)) return send(res, 200, file)
      if (!/\.[a-z0-9]+$/i.test(p)) return send(res, 200, join(WEB, 'index.html'))
      return send(res, 404, join(SITE(), '404.html'))
    }

    if (/^\/media\/m_[A-Za-z0-9_-]+\.(png|jpg|webp)$/.test(p) && isFile(join(app.site.outputDir, p))) {
      return send(res, 200, join(app.site.outputDir, p))
    }

    for (const c of [p.endsWith('/') ? `${p}index.html` : p, `${p}.html`]) {
      if (isFile(join(SITE(), c))) return send(res, 200, join(SITE(), c))
    }
    send(res, 404, join(SITE(), '404.html'))
  })
}).listen(PORT, '127.0.0.1', () => {
  console.log(`vault dev stack on http://localhost:${PORT}  (owner: ${OWNER}, registration ${app.allowRegistration ? 'open' : 'closed'})`)
})
