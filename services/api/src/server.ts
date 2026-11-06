// The API as a long-running process.
//
// Caddy terminates TLS and proxies /api/* here over the loopback interface, so
// this listens on localhost only and speaks plain HTTP. It is never reachable
// from outside the host.
//
// The handler underneath is the same one the tests drive: it takes an event and
// returns a response. This translates Node's request and response objects into
// that shape and back.

import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildRouter } from './app.js'
import { loadConfig } from './config.js'
import { emailDigest } from './identity.js'
import type { App } from './context.js'
import { type LambdaEvent, errorResponse } from './http.js'
import { publishToDisk } from './site.js'
import { MysqlStore } from './store-mysql.js'

const PORT = Number(process.env['PORT'] ?? 3000)
const HOST = '127.0.0.1'

/** Bodies are small — one sealed entry, or one image of at most 2 MB sent as
 *  base64 from the admin panel. A cap stops a single request from consuming
 *  the memory of a 1 GB host. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

function buildApp(): { app: App; store: MysqlStore } {
  const config = loadConfig()
  const store = new MysqlStore(config.db)
  const app: App = {
    config,
    store,
    now: () => Date.now(),
    // Closed unless explicitly opened, so a missing or misspelled setting
    // refuses registration rather than leaving the vault open to whoever finds
    // the address.
    allowRegistration: process.env['ALLOW_REGISTRATION'] === 'true',
    // Comma-separated addresses in secrets.env. Turned into digests here and
    // the addresses themselves are not kept.
    adminDigests: new Set(
      (process.env['ADMIN_EMAILS'] ?? '')
        .split(',')
        .map((e) => e.trim())
        .filter(Boolean)
        .map((e) => emailDigest(e, config.pepper)),
    ),
    // The website's templates ship beside this file in each release (api/site);
    // rendered versions go where the unit lets this process write.
    site: {
      sourceDir: process.env['SITE_SOURCE'] ?? join(dirname(fileURLToPath(import.meta.url)), 'site'),
      outputDir: process.env['SITE_ROOT'] ?? '/srv/vault/site',
      origin: process.env['SITE_ORIGIN'] ?? `https://${process.env['VAULT_HOSTNAME'] ?? 'vault-shivam.duckdns.org'}`,
    },
  }
  return { app, store }
}

export async function start(): Promise<void> {
  const { app, store } = buildApp()

  // Idempotent, and run on every start so a fresh database needs no manual
  // step. If it fails the process exits rather than serving requests against a
  // schema that may not be there.
  await store.migrate()

  // Render the live website before taking requests, so a new release serves
  // its own templates from the first request. A failure is logged and the
  // previous render keeps serving; the API itself does not depend on it.
  if (app.site) {
    try {
      await publishToDisk(app, app.site)
    } catch (err) {
      console.error('could not render the website; the previous version stays live:', (err as Error).message)
    }
  }

  const router = buildRouter(app)

  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    let size = 0
    let aborted = false

    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        aborted = true
        res.writeHead(413, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'too_large', message: 'Request body is too large.' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      if (aborted) return
      void (async () => {
        const url = new URL(req.url ?? '/', `http://${HOST}`)
        const event: LambdaEvent = {
          rawPath: url.pathname,
          rawQueryString: url.search.replace(/^\?/, ''),
          headers: req.headers as Record<string, string | undefined>,
          ...(chunks.length ? { body: Buffer.concat(chunks).toString('utf8') } : {}),
          requestContext: {
            http: {
              method: req.method ?? 'GET',
              // Caddy sets X-Forwarded-For; without it every request would
              // appear to come from the loopback address and per-address rate
              // limiting would apply to everyone at once.
              sourceIp: (req.headers['x-forwarded-for'] ?? '').toString().split(',')[0]?.trim() || '127.0.0.1',
              ...(req.headers['user-agent'] ? { userAgent: req.headers['user-agent'] } : {}),
            },
          },
        }

        const result = await router.handle(event).catch((err: unknown) => errorResponse(err))
        res.writeHead(result.statusCode, result.headers)
        res.end(result.body)
      })()
    })
  })

  server.listen(PORT, HOST, () => {
    console.log(`vault api listening on ${HOST}:${PORT}`)
  })

  // systemd restarts on failure; the job here is to exit rather than linger in
  // a state nothing can diagnose.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      server.close(() => {
        void store.close().finally(() => process.exit(0))
      })
    })
  }
}
