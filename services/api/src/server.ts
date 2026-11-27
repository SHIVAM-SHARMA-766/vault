// The API as a long-running process.
//
// Caddy terminates TLS and proxies /api/* here over the loopback interface, so
// this listens on localhost only and speaks plain HTTP. It is never reachable
// from outside the host.
//
// The handler underneath is the same one the tests drive: it takes an event and
// returns a response. This translates Node's request and response objects into
// that shape and back.

import { checkEditionFits } from './edition.js'
import { createServer } from 'node:http'

import { buildRouter, handleRequest } from './app.js'
import { loadConfig } from './config.js'
import { emailDigest } from './identity.js'
import type { App } from './context.js'
import type { LambdaEvent } from './http.js'
import { publishToDisk } from './site.js'
import { ensureSetup } from './system.js'
import { createMailer } from './mail.js'
import { tick as tickPersonalBackups } from './personal-backup.js'
import { applyRetention } from './retention.js'
import { takeBackupRequest } from './backup.js'
import { closeStaleTickets } from './routes/desk.js'
import { migrateItemPartitions } from './routes/orgs.js'
import { backupsEnabled, runBackup } from './backup.js'
import { serveStatic } from './web.js'
import { openStore } from './storage/index.js'
import type { ManagedStore } from './store.js'
import { tickDigest } from './routes/insights.js'

const HOST = 'localhost'

/** Bodies are small — one sealed entry, or one image of at most 2 MB sent as
 *  base64 from the admin panel. A cap stops a single request from consuming
 *  the memory of a 1 GB host. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

export async function buildApp(): Promise<{ app: App; store: ManagedStore }> {
  const config = loadConfig()
  const store = await openStore(config)
  const mailer = await createMailer(config)
  const app: App = {
    config,
    store,
    now: () => Date.now(),
    ...(mailer ? { mailer } : {}),
    // Closed unless explicitly opened (config.ts), so a missing or misspelled
    // setting refuses registration rather than leaving the vault open.
    allowRegistration: config.allowRegistration,
    adminDigests: new Set(config.adminEmails.map((e) => emailDigest(e, config.pepper))),
    // The website's templates ship beside this file in each release (api/site);
    // rendered versions go where the unit lets this process write.
    site: { ...config.site, origin: config.origin },
  }
  return { app, store }
}

export async function start(): Promise<void> {
  const { app, store } = await buildApp()

  // Idempotent, and run on every start so a fresh database needs no manual
  // step. If it fails the process exits rather than serving requests against a
  // schema that may not be there.
  const version = await store.migrate()
  console.log(`storage: ${app.config.db.driver}, schema version ${version}`)

  // Scheduled backups (backup.ts), when a passphrase and a destination are set.
  if (backupsEnabled(app.config) && app.config.backup.intervalHours > 0) {
    const backup = () => runBackup(store, app.config)
      .then((r) => console.log(`backup written: ${r.name} (${r.rows} rows, ${r.bytes} bytes)`))
      .catch((err: unknown) => console.error('backup FAILED:', (err as Error).message))
    setTimeout(() => { void backup(); setInterval(backup, app.config.backup.intervalHours * 3_600_000).unref() }, 5 * 60_000).unref()
    // "Back up now" from the admin panel (C7): a request row, taken here.
    setInterval(() => void takeBackupRequest(store, app.config).catch((err: unknown) => console.error('backup FAILED:', (err as Error).message)), 60_000).unref()
    console.log(`backups: every ${app.config.backup.intervalHours} h${app.config.backup.dir ? `, to ${app.config.backup.dir}` : ''}${app.config.backup.s3 ? `, to s3://${app.config.backup.s3.bucket}` : ''}; first in 5 minutes`)
  } else if (!backupsEnabled(app.config)) {
    console.log('backups: off (set BACKUP_PASSPHRASE and BACKUP_DIR or BACKUP_S3_*; see docs/INSTALL.md)')
  }

  console.log(app.mailer ? `mail: via ${app.config.mail.host}:${app.config.mail.port}` : 'mail: off (set SMTP_HOST and MAIL_FROM to send invitations and security notices)')

  // An edition smaller than what the server holds is refused (decisions/0030).
  await checkEditionFits(app)
  console.log(`edition: ${app.config.edition}`)

  const movedItems = await migrateItemPartitions(app)
  if (movedItems) console.log(`moved ${movedItems} shared item(s) into organization-scoped storage`)

  // A brand-new server: say how to create the owner account.
  const setupCode = await ensureSetup(app)
  if (setupCode) {
    console.log([
      '',
      '  ┌─ First-run setup ─────────────────────────────────────────────',
      '  │ No accounts exist yet. Open this link to create the owner:',
      `  │   ${app.config.origin}/app/?setup=${encodeURIComponent(setupCode)}`,
      `  │ or choose "Create an account" and enter the code ${setupCode}`,
      '  │ It works once, for 7 days; a new one is printed on every start',
      '  │ until it is used.',
      '  └───────────────────────────────────────────────────────────────',
      '',
    ].join('\n'))
  }

  // Expired rows (sessions, activity, rate windows) are removed here for every
  // driver. MySQL also has a scheduled event; sweeping twice costs nothing.
  const sweep = () => Promise.all([store.sweepExpired(), closeStaleTickets(app)])
    .catch((err: unknown) => console.error('expiry sweep failed:', (err as Error).message))
  void sweep()
  setInterval(sweep, 15 * 60 * 1000).unref()

  // Logs older than the server policy's retention, after it was shortened.
  const retention = () => applyRetention(app)
    .catch((err: unknown) => console.error('retention pass failed:', (err as Error).message))
  void retention()
  setInterval(retention, 6 * 3_600_000).unref()

  // The weekly summary to owners and admins (admin console phase 2): checked
  // every hour, sent when a week has passed since the last.
  const digest = () => tickDigest(app)
    .catch((err: unknown) => console.error('weekly digest failed:', (err as Error).message))
  setInterval(digest, 3_600_000).unref()

  // Personal backups that have fallen due (decisions/0017).
  const personal = () => tickPersonalBackups(app)
    .catch((err: unknown) => console.error('personal backups failed:', (err as Error).message))
  setInterval(personal, 5 * 60 * 1000).unref()

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

  const { config } = app
  const roots = { web: config.webRoot, site: config.site.outputDir, origin: config.origin }

  const server = createServer((req, res) => {
    // Not the API: the client, the website and media, when this process
    // serves them itself (src/web.ts). Otherwise a proxy in front does.
    if (!(req.url ?? '/').startsWith('/api/')) {
      if (config.serveStatic) serveStatic(req, res, roots)
      else { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"not_found","message":"Not found."}') }
      return
    }
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
              // Behind a proxy (TRUST_PROXY=true), the client is the address
              // the proxy appended to X-Forwarded-For; without it every request would
              // seem to come from the proxy and per-address rate limits
              // would apply to everyone at once. Exposed directly, that
              // header is whatever the client says, so the socket is used.
              sourceIp: config.trustProxy
                // The rightmost entry is the one our proxy added; anything to
                // its left came from the client and can be forged.
                ? (req.headers['x-forwarded-for'] ?? '').toString().split(',').map((x) => x.trim()).filter(Boolean).pop() || req.socket.remoteAddress || '127.0.0.1'
                : req.socket.remoteAddress || '127.0.0.1',
              ...(req.headers['user-agent'] ? { userAgent: req.headers['user-agent'] } : {}),
            },
          },
        }

        const result = await handleRequest(router, event, { log: true })
        res.writeHead(result.statusCode, result.headers)
        res.end(result.body)
      })()
    })
  })

  server.listen(app.config.port, app.config.host, () => {
    console.log(`vault api listening on ${app.config.host}:${app.config.port}${app.config.serveStatic ? ' (serving client and site)' : ''}`)
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
