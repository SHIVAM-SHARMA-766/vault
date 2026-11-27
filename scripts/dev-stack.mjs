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
import { mkdtempSync, statSync } from 'node:fs'
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
const { serveStatic } = await import(join(API, 'web.js'))

const PORT = Number(process.env.PORT ?? 8080)
const OWNER = process.env.OWNER_EMAIL ?? 'owner@example.test'
const PEPPER = 'dev-stack-pepper-not-a-secret-0000000000'

// POST /__dev/clock?skip=<minutes> moves the server's clock on, so a test can
// see what happens after a time limit (the ten-minute sudo window) without
// waiting for it.
let clockSkew = 0

const app = {
  store: new MemoryStore(),
  now: () => Date.now() + clockSkew,
  // Open so the first account can be made; the admin panel can close it, and
  // POST /__dev/registration?open=0 does the same from a test.
  allowRegistration: OWNER !== '' && process.env.REGISTRATION !== 'closed',
  // OWNER_EMAIL= (empty) starts like a brand-new server: no owner, closed,
  // and a first-run setup code in the log.
  adminDigests: new Set(OWNER ? [emailDigest(OWNER, PEPPER)] : []),
  site: { sourceDir: join(ROOT, 'apps/site'), outputDir: mkdtempSync(join(tmpdir(), 'vault-dev-site-')), origin: `http://localhost:${PORT}` },
  config: {
    port: PORT, host: '127.0.0.1', trustProxy: true, serveStatic: true, webRoot: '', origin: `http://localhost:${PORT}`, allowRegistration: true, adminEmails: OWNER ? [OWNER] : [],
    // EDITION=personal|business|hosted (decisions/0030); hosted by default, as in production.
    edition: process.env.EDITION || 'hosted',
    hostedTenants: process.env.EDITION === 'hosted',
    site: { sourceDir: '', outputDir: '' },
    backup: { passphrase: '', dir: '', keep: 14, intervalHours: 0 },
    // Personal backups: remote destinations on; private addresses off, as in production.
    personalBackup: { remote: true, allowPrivate: false },
    // No calls to the release feed from a development stack.
    version: 'dev', updateCheck: { enabled: false, url: '' },
    breachCheck: { enabled: Boolean(process.env.BREACH_CHECK_URL), url: process.env.BREACH_CHECK_URL ?? '' },
    metricsToken: process.env.METRICS_TOKEN ?? '', auditWebhook: { url: '', secret: '' },
    // CLOUD_MOCK: a stand-in for Google and Microsoft in browser tests.
    cloudDrive: process.env.CLOUD_MOCK ? {
      google: { clientId: 'g-e2e', clientSecret: 'g-e2e-secret' }, microsoft: { clientId: 'm-e2e', clientSecret: 'm-e2e-secret' },
      endpoints: { googleAuth: `${process.env.CLOUD_MOCK}/g/auth`, googleToken: `${process.env.CLOUD_MOCK}/g/token`, googleApi: `${process.env.CLOUD_MOCK}/gapi`, msAuth: `${process.env.CLOUD_MOCK}/m/auth`, msToken: `${process.env.CLOUD_MOCK}/m/token`, msGraph: `${process.env.CLOUD_MOCK}/graph` },
    } : { google: null, microsoft: null },
    oidc: process.env.OIDC_ISSUER ? { issuer: process.env.OIDC_ISSUER.replace(/\/+$/, ''), clientId: process.env.OIDC_CLIENT_ID ?? '', clientSecret: process.env.OIDC_CLIENT_SECRET ?? '', name: process.env.OIDC_NAME || 'SSO', provision: process.env.OIDC_PROVISION === 'true', requireVerifiedEmail: process.env.OIDC_REQUIRE_VERIFIED_EMAIL !== 'false' } : null,
    saml: process.env.SAML_IDP_SSO_URL ? { ssoUrl: process.env.SAML_IDP_SSO_URL, cert: (process.env.SAML_IDP_CERT ?? '').replace(/\\n/g, '\n'), entityId: process.env.SAML_SP_ENTITY_ID || `http://localhost:${PORT}/api/auth/sso/saml/metadata`, name: process.env.SAML_NAME || 'SSO', provision: process.env.SAML_PROVISION === 'true', emailAttribute: process.env.SAML_EMAIL_ATTRIBUTE ?? '' } : null,
    mail: { host: '', port: 587, user: '', password: '', from: '', signInNotices: true },
    db: { driver: 'mysql', host: 'memory', user: 'dev', password: 'dev', database: 'dev', port: 0, ssl: false, path: '' },
    pepper: PEPPER, tokenKey: 'dev-stack-token-key-not-a-secret-000000',
  },
}
// DEV_MAIL=1: mail is "sent" into a list a test can read at /__dev/outbox.
const outbox = []
if (process.env.DEV_MAIL) app.mailer = { send: async (m) => { outbox.push({ to: m.to, subject: m.subject, text: m.text }) } }
const router = buildRouter(app)
await publishToDisk(app, app.site)
const { ensureSetup } = await import(join(API, 'system.js'))
const setupCode = await ensureSetup(app)
if (setupCode) console.log(`setup code: ${setupCode}`)

const WEB = join(ROOT, 'apps/web/dist')

createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', async () => {
    const url = new URL(req.url ?? '/', 'http://local')
    const p = decodeURIComponent(url.pathname)
    if (p.includes('..')) { res.writeHead(400); return res.end() }

    if (p === '/__dev/outbox' && process.env.DEV_MAIL) {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify(outbox))
    }

    if (p === '/__dev/clock' && req.method === 'POST') {
      clockSkew += Number(url.searchParams.get('skip') ?? 0) * 60_000
      return res.end(JSON.stringify({ skewMinutes: clockSkew / 60_000 }))
    }

    if (p === '/__dev/registration' && req.method === 'POST') {
      app.allowRegistration = url.searchParams.get('open') === '1'
      return res.end(JSON.stringify({ open: app.allowRegistration }))
    }

    if (p.startsWith('/api/')) {
      const r = await handleRequest(router, {
        rawPath: p, rawQueryString: url.search.slice(1), headers: req.headers,
        ...(chunks.length ? { body: Buffer.concat(chunks).toString('utf8') } : {}),
        // Each test browser sends its own address (tests/e2e/helpers.mjs), as
        // different people behind a proxy would; otherwise they all share one
        // per-address rate limit.
        requestContext: { http: { method: req.method ?? 'GET', sourceIp: String(req.headers['x-forwarded-for'] ?? '127.0.0.1').split(',')[0].trim(), userAgent: String(req.headers['user-agent'] ?? '') } },
      })
      res.writeHead(r.statusCode, r.headers)
      return res.end(r.body)
    }

    // Everything else exactly as the self-hosted server serves it (src/web.ts).
    serveStatic(req, res, { web: WEB, site: app.site.outputDir, origin: `http://localhost:${PORT}` })
  })
}).listen(PORT, '127.0.0.1', () => {
  console.log(`vault dev stack on http://localhost:${PORT}  (owner: ${OWNER}, registration ${app.allowRegistration ? 'open' : 'closed'})`)
})
