// Runtime configuration: every setting the server reads, in one place.
//
// Each variable is declared once in VARIABLES — name, whether it is required,
// its default, whether it is secret, and what it does — and docs/configuration.md
// lists the same set (a test keeps them in step). Nothing else in the service
// reads process.env, and nothing has a default that names a particular
// installation: a self-hosted server must say what its address is.
//
// The database password and the two server secrets come from the environment,
// which systemd fills from a root-owned file on the host. They are
// deliberately not passed through instance metadata, which anything running on
// the host can read, nor through Terraform, whose state file ends up in
// plaintext on laptops and CI runners. See docs/runbook.md.

import { EDITIONS, type Edition } from './edition.js'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function edition(value: string): Edition {
  if (!value) return 'hosted'
  if (!(EDITIONS as readonly string[]).includes(value)) throw new Error(`EDITION must be one of ${EDITIONS.join(', ')}`)
  return value as Edition
}

export interface Config {
  port: number
  /** Address to listen on. 127.0.0.1 behind a local proxy; 0.0.0.0 in a container. */
  host: string
  /** Use X-Forwarded-For for the client address. Only behind a proxy. */
  trustProxy: boolean
  /** Serve the client, website and media from this process (src/web.ts). */
  serveStatic: boolean
  /** The built client, when serveStatic. */
  webRoot: string
  /** The public origin, e.g. https://vault.example.com. Used for absolute URLs
   *  on the rendered website. */
  origin: string
  db: {
    driver: 'mysql' | 'postgres' | 'sqlite'
    host: string
    user: string
    password: string
    database: string
    port: number
    /** TLS to the database server (postgres). */
    ssl: boolean
    /** The database file (sqlite). */
    path: string
  }
  /** HMAC key for email digests and decoy salts. */
  pepper: string
  /** HMAC key for access and refresh tokens. */
  tokenKey: string
  /** Which features this server has (decisions/0030). */
  edition: Edition
  /** Closed unless explicitly opened. */
  allowRegistration: boolean
  /** Addresses that hold the owner role. Turned into digests by the server;
   *  the addresses are not kept. */
  adminEmails: string[]
  site: { sourceDir: string; outputDir: string }
  mail: { host: string; port: number; user: string; password: string; from: string; signInNotices: boolean }
  backup: {
    passphrase: string
    dir: string
    keep: number
    intervalHours: number
    s3?: { endpoint: string; region: string; bucket: string; accessKey: string; secretKey: string; prefix: string }
  }
  /** Each person's own backups (decisions/0017). */
  personalBackup: { remote: boolean; allowPrivate: boolean }
  /** This build's version (the image sets it); "dev" otherwise. */
  version: string
  /** The admin panel's "a newer version is available". */
  updateCheck: { enabled: boolean; url: string }
  /** Pwned Passwords range lookups relayed for the breach check (decisions/0019). */
  breachCheck: { enabled: boolean; url: string }
  /** Prometheus metrics at /api/metrics (B6), for a scraper holding this token; '' for off. */
  metricsToken: string
  /** Every audit and organization event sent to a SIEM or log pipeline (B7); '' for off. */
  auditWebhook: { url: string; secret: string }
}

export interface Variable {
  name: string
  required: boolean
  default?: string
  secret?: boolean
  description: string
}

export const VARIABLES: readonly Variable[] = [
  { name: 'VAULT_HOSTNAME', required: false, description: 'The public hostname, e.g. vault.example.com. Either this or SITE_ORIGIN is required.' },
  { name: 'SITE_ORIGIN', required: false, description: 'The public origin with scheme, e.g. https://vault.example.com. Overrides https://VAULT_HOSTNAME.' },
  { name: 'PORT', required: false, default: '3000', description: 'Port to listen on.' },
  { name: 'HOST', required: false, default: '127.0.0.1', description: 'Address to listen on. 0.0.0.0 in a container; 127.0.0.1 behind a proxy on the same host.' },
  { name: 'TRUST_PROXY', required: false, default: 'true', description: '"true" when a reverse proxy sets X-Forwarded-For. Set "false" if clients reach the server directly, or they can forge their address and dodge rate limits.' },
  { name: 'SERVE_STATIC', required: false, default: 'false', description: '"true" to serve the client, website and media from this process, so no web server is needed in front (TLS still is).' },
  { name: 'WEB_ROOT', required: false, description: 'The built client. Defaults to the web/ directory shipped beside the server.' },
  { name: 'DB_DRIVER', required: false, default: 'mysql', description: 'mysql, postgres or sqlite. SQLite needs no database server; PostgreSQL suits several app instances.' },
  { name: 'DB_PATH', required: false, default: '/var/lib/vault/vault.db', description: 'SQLite only: the database file. Its directory must be writable and backed up.' },
  { name: 'DB_HOST', required: false, description: 'MySQL or PostgreSQL host. Required for those drivers.' },
  { name: 'DB_PORT', required: false, description: 'Database port. Defaults to 3306 for MySQL, 5432 for PostgreSQL.' },
  { name: 'DB_USER', required: false, default: 'vault', description: 'Database user.' },
  { name: 'DB_NAME', required: false, default: 'vault', description: 'Database name. The schema is created and migrated on start.' },
  { name: 'DB_PASSWORD', required: false, secret: true, description: 'Database password. Required for MySQL and PostgreSQL.' },
  { name: 'DB_SSL', required: false, default: 'false', description: 'PostgreSQL only: "true" to require a verified TLS connection.' },
  { name: 'SECRETS_FILE', required: false, description: 'A file holding SERVER_PEPPER and TOKEN_SIGNING_KEY. If it does not exist, both are generated and written there (mode 0600) on first start. The container image sets /data/secrets.env. Back it up with the database: without the pepper nobody can sign in.' },
  { name: 'SERVER_PEPPER', required: true, secret: true, description: 'At least 32 characters (openssl rand -base64 32). Keys the address digests. Changing it locks every account out.' },
  { name: 'TOKEN_SIGNING_KEY', required: true, secret: true, description: 'At least 32 characters. Signs session tokens. Changing it signs everyone out.' },
  { name: 'EDITION', required: false, default: 'hosted', description: 'personal (one account, no organizations or invitations), business (the company\'s server) or hosted (everything). The install profiles set it. See decisions/0030.' },
  { name: 'ALLOW_REGISTRATION', required: false, default: 'false', description: '"true" forces registration open, overriding the admin panel. For creating the first account only.' },
  { name: 'ADMIN_EMAILS', required: false, default: '', description: 'Comma-separated addresses that are owners. The first account is usually the only one.' },
  { name: 'SITE_SOURCE', required: false, description: 'Website templates and content. Defaults to the site/ directory shipped beside the server.' },
  { name: 'SITE_ROOT', required: false, default: '/srv/vault/site', description: 'Where the rendered website is written; the reverse proxy serves its current/ directory.' },
  { name: 'SMTP_HOST', required: false, description: 'Your mail server, for invitations and security notices. Mail is off without it.' },
  { name: 'SMTP_PORT', required: false, default: '587', description: '587 (STARTTLS, required) or 465 (TLS). Plain-text SMTP is refused.' },
  { name: 'SMTP_USER', required: false, description: 'SMTP user name, if the server needs one.' },
  { name: 'SMTP_PASSWORD', required: false, secret: true, description: 'SMTP password.' },
  { name: 'MAIL_FROM', required: false, description: 'The sender, e.g. "Vault <vault@example.com>". Required with SMTP_HOST.' },
  { name: 'MAIL_SIGNIN_NOTICES', required: false, default: 'true', description: '"false" stops the email sent on every sign-in. Recovery-key sign-ins are always notified.' },
  { name: 'BACKUP_PASSPHRASE', required: false, secret: true, description: 'Turns scheduled backups on (with BACKUP_DIR or BACKUP_S3_*). At least 16 characters. Keep a copy away from the server: a backup and this passphrase are a complete restore, and without it a backup cannot be opened.' },
  { name: 'BACKUP_DIR', required: false, description: 'Directory for backup files. The container image uses /data/backups.' },
  { name: 'BACKUP_KEEP', required: false, default: '14', description: 'How many backup files to keep in BACKUP_DIR. Use the bucket\'s lifecycle rules for S3.' },
  { name: 'BACKUP_INTERVAL_HOURS', required: false, default: '24', description: 'Hours between scheduled backups; 0 turns the schedule off (the backup command still works).' },
  { name: 'BACKUP_S3_ENDPOINT', required: false, description: 'An S3-compatible endpoint for off-site copies, e.g. https://s3.eu-central-1.amazonaws.com or https://<account>.r2.cloudflarestorage.com.' },
  { name: 'BACKUP_S3_BUCKET', required: false, description: 'The bucket. Required with BACKUP_S3_ENDPOINT.' },
  { name: 'BACKUP_S3_REGION', required: false, default: 'us-east-1', description: 'Signing region; "auto" for R2.' },
  { name: 'BACKUP_S3_ACCESS_KEY', required: false, description: 'Access key id. Give it permission to write objects in that bucket and nothing else.' },
  { name: 'BACKUP_S3_SECRET_KEY', required: false, secret: true, description: 'Secret access key.' },
  { name: 'BACKUP_S3_PREFIX', required: false, default: 'vault/', description: 'Key prefix for backup objects.' },
  { name: 'VAULT_VERSION', required: false, default: 'dev', description: 'This build\'s version. The container image sets it; leave it alone.' },
  { name: 'UPDATE_CHECK', required: false, default: 'true', description: '"false" stops the admin panel checking for a newer release (at most every 12 hours, from the server).' },
  { name: 'METRICS_TOKEN', required: false, default: '', description: 'A long random token; when set, /api/metrics serves Prometheus metrics to requests with "Authorization: Bearer <token>". Counts only, never vault content or addresses.' },
  { name: 'AUDIT_WEBHOOK_URL', required: false, default: '', description: 'An https:// address that receives each admin audit and organization event as JSON (a SIEM, Splunk HEC, an Elastic or log-pipeline endpoint). Best effort; events stay in the audit log either way.' },
  { name: 'AUDIT_WEBHOOK_SECRET', required: false, default: '', description: 'Signs each webhook body: header X-Vault-Signature: sha256=<HMAC-SHA256 of the body>.' },
  { name: 'BREACH_CHECK', required: false, default: 'true', description: '"false" turns off the breach check: the server relays no password-hash prefixes to Pwned Passwords and the button is hidden.' },
  { name: 'BREACH_CHECK_URL', required: false, default: 'https://api.pwnedpasswords.com/range/', description: 'The Pwned Passwords range API, ending in /; the 5-character hash prefix is appended. For a mirror inside your network.' },
  { name: 'UPDATE_CHECK_URL', required: false, default: 'https://api.github.com/repos/SHIVAM-SHARMA-766/vault/releases/latest', description: 'Where to look for the latest release: a GitHub latest-release API address, for a fork or a mirror.' },
  { name: 'PERSONAL_BACKUP_REMOTE', required: false, default: 'true', description: '"false" limits personal backups to copies kept on this server: no outbound connections to people\'s own S3 buckets or WebDAV folders.' },
  { name: 'PERSONAL_BACKUP_ALLOW_PRIVATE', required: false, default: 'false', description: '"true" lets personal backups reach private and loopback addresses, and plain http — for a NAS on the LAN. Leave it off on a server reachable from the internet: it lets any account make this server connect inside your network.' },
]

let cached: Config | null = null

/** Reads and checks the whole configuration, reporting every problem at once
 *  rather than one per restart. Refuses weak or placeholder secrets: a server
 *  that starts with a guessable pepper is worse than one that does not start,
 *  because nothing about it looks wrong. */
export function parseConfig(env: Record<string, string | undefined>, here = dirname(fileURLToPath(import.meta.url))): Config {
  const problems: string[] = []
  const get = (name: string): string => {
    const v = VARIABLES.find((x) => x.name === name)!
    const value = env[name] ?? v.default ?? ''
    if (v.required && !value) problems.push(`${name} is required: ${v.description}`)
    return value
  }
  const secret = (name: string): string => {
    const value = get(name)
    if (!value) return value
    if (value.length < 32) problems.push(`${name} is too short; generate one with: openssl rand -base64 32`)
    else if (/^(placeholder|changeme|test|secret)/i.test(value)) problems.push(`${name} still holds a placeholder value`)
    return value
  }
  const number = (name: string): number => {
    const n = Number(get(name))
    if (!Number.isInteger(n) || n <= 0 || n > 65535) problems.push(`${name} must be a port number`)
    return n
  }

  const hostname = get('VAULT_HOSTNAME')
  let origin = get('SITE_ORIGIN') || (hostname ? `https://${hostname}` : '')
  if (!origin) problems.push('VAULT_HOSTNAME (or SITE_ORIGIN) is required: the address people use to reach this server.')
  else {
    try { origin = new URL(origin).origin } catch { problems.push(`SITE_ORIGIN is not a URL: ${origin}`) }
  }

  const driver = get('DB_DRIVER')
  if (!['mysql', 'postgres', 'sqlite'].includes(driver)) problems.push(`DB_DRIVER must be mysql, postgres or sqlite, not "${driver}"`)
  const server = driver === 'mysql' || driver === 'postgres'
  if (server && !get('DB_HOST')) problems.push(`DB_HOST is required for ${driver}`)
  if (server && !get('DB_PASSWORD')) problems.push(`DB_PASSWORD is required for ${driver}`)
  if (!env['DB_PORT']) env = { ...env, DB_PORT: driver === 'postgres' ? '5432' : '3306' }

  const config: Config = {
    port: number('PORT'),
    host: get('HOST'),
    trustProxy: get('TRUST_PROXY') !== 'false',
    serveStatic: get('SERVE_STATIC') === 'true',
    webRoot: get('WEB_ROOT') || join(here, 'web'),
    origin,
    db: {
      driver: driver as Config['db']['driver'],
      host: get('DB_HOST'), user: get('DB_USER'), password: get('DB_PASSWORD'), database: get('DB_NAME'),
      port: number('DB_PORT'), ssl: get('DB_SSL') === 'true', path: get('DB_PATH'),
    },
    pepper: secret('SERVER_PEPPER'),
    tokenKey: secret('TOKEN_SIGNING_KEY'),
    edition: edition(get('EDITION')),
    allowRegistration: get('ALLOW_REGISTRATION') === 'true',
    adminEmails: get('ADMIN_EMAILS').split(',').map((e) => e.trim()).filter(Boolean),
    site: { sourceDir: get('SITE_SOURCE') || join(here, 'site'), outputDir: get('SITE_ROOT') },
    backup: { passphrase: '', dir: '', keep: 14, intervalHours: 24 },
    mail: { host: '', port: 587, user: '', password: '', from: '', signInNotices: true },
    personalBackup: { remote: get('PERSONAL_BACKUP_REMOTE') !== 'false', allowPrivate: get('PERSONAL_BACKUP_ALLOW_PRIVATE') === 'true' },
    version: get('VAULT_VERSION') || 'dev',
    updateCheck: { enabled: get('UPDATE_CHECK') !== 'false', url: get('UPDATE_CHECK_URL') },
    breachCheck: { enabled: get('BREACH_CHECK') !== 'false', url: get('BREACH_CHECK_URL') },
    metricsToken: get('METRICS_TOKEN'),
    auditWebhook: { url: get('AUDIT_WEBHOOK_URL'), secret: get('AUDIT_WEBHOOK_SECRET') },
  }
  const smtpHost = get('SMTP_HOST')
  if (smtpHost && !get('MAIL_FROM')) problems.push('MAIL_FROM is required with SMTP_HOST')
  config.mail = {
    host: smtpHost, port: number('SMTP_PORT'), user: get('SMTP_USER'), password: get('SMTP_PASSWORD'),
    from: get('MAIL_FROM'), signInNotices: get('MAIL_SIGNIN_NOTICES') !== 'false',
  }

  const passphrase = get('BACKUP_PASSPHRASE')
  if (passphrase && passphrase.length < 16) problems.push('BACKUP_PASSPHRASE must be at least 16 characters')
  const s3Fields = ['BACKUP_S3_ENDPOINT', 'BACKUP_S3_BUCKET', 'BACKUP_S3_ACCESS_KEY', 'BACKUP_S3_SECRET_KEY']
  const s3Set = s3Fields.filter((n) => get(n))
  if (s3Set.length && s3Set.length < s3Fields.length) problems.push(`S3 backups need all of ${s3Fields.join(', ')}; missing ${s3Fields.filter((n) => !get(n)).join(', ')}`)
  const keep = Number(get('BACKUP_KEEP'))
  const intervalHours = Number(get('BACKUP_INTERVAL_HOURS'))
  if (!Number.isInteger(keep) || keep < 1) problems.push('BACKUP_KEEP must be a whole number, 1 or more')
  if (!Number.isFinite(intervalHours) || intervalHours < 0) problems.push('BACKUP_INTERVAL_HOURS must be 0 or more')
  config.backup = {
    passphrase, dir: get('BACKUP_DIR'), keep, intervalHours,
    ...(s3Set.length === s3Fields.length ? { s3: {
      endpoint: get('BACKUP_S3_ENDPOINT'), bucket: get('BACKUP_S3_BUCKET'), region: get('BACKUP_S3_REGION'),
      accessKey: get('BACKUP_S3_ACCESS_KEY'), secretKey: get('BACKUP_S3_SECRET_KEY'), prefix: get('BACKUP_S3_PREFIX'),
    } } : {}),
  }

  if (problems.length) throw new Error(`configuration:\n  - ${problems.join('\n  - ')}`)
  return config
}

/** Merges SECRETS_FILE into the environment, creating it with fresh secrets
 *  the first time. Values set in the environment win over the file. */
export function withSecretsFile(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const file = env['SECRETS_FILE']
  if (!file) return env
  if (!existsSync(file)) {
    const generated = [
      '# Generated by Vault on first start. Back this file up with the database:',
      '# without SERVER_PEPPER nobody can sign in. Never share it.',
      `SERVER_PEPPER=${randomBytes(32).toString('base64')}`,
      `TOKEN_SIGNING_KEY=${randomBytes(48).toString('base64')}`,
      '',
    ].join('\n')
    writeFileSync(file, generated, { mode: 0o600, flag: 'wx' })
    console.log(`generated server secrets in ${file}`)
  }
  const fromFile: Record<string, string> = {}
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (m) fromFile[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2')
  }
  return { ...fromFile, ...Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== '')) }
}

export function loadConfig(): Config {
  cached ??= parseConfig(withSecretsFile(process.env))
  return cached
}

/** Tests only. */
export function setConfigForTesting(config: Config | null): void {
  cached = config
}
