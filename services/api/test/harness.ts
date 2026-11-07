// An in-memory Store and a request helper, so the routes can be driven end to
// end without an AWS account. The implementation mirrors the DynamoDB one's
// semantics that the routes actually depend on: point lookups, conditional
// writes, prefix queries on the sort key, and atomic counters.

import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { dispatch } from '../src/app.js'
import type { App } from '../src/context.js'
import type { LambdaEvent, LambdaResponse } from '../src/http.js'
import { emailDigest } from '../src/identity.js'
import type { Message } from '../src/mail.js'
import { MemoryStore } from '../src/store-memory.js'

export { MemoryStore }
import { AUTH_HEADER } from '../src/tokens.js'

export interface Harness {
  app: App
  store: MemoryStore
  /** Mail "sent" when the harness was made with { mail: true }. */
  outbox: Message[]
  request(method: string, path: string, options?: RequestOptions): Promise<Parsed>
  setNow(ms: number): void
}

export interface RequestOptions {
  body?: unknown
  token?: string
  ip?: string
  /** Headers set verbatim, for asserting what the service does with a header
   *  it should ignore. */
  rawHeaders?: Record<string, string>
}

export interface Parsed {
  status: number
  headers: Record<string, string>
  body: Record<string, unknown>
}

export function harness(options: { allowRegistration?: boolean; adminEmails?: string[]; siteOutput?: string; mail?: boolean; allowPrivate?: boolean; remoteBackups?: boolean } = {}): Harness {
  const store = new MemoryStore()
  const outbox: Message[] = []
  let now = Date.UTC(2026, 8, 22, 12, 0, 0)

  const app: App = {
    store,
    config: {
      port: 3000,
      host: '127.0.0.1',
      trustProxy: true,
      serveStatic: false,
      webRoot: '',
      origin: 'https://vault.test',
      allowRegistration: false,
      adminEmails: [],
      site: { sourceDir: '', outputDir: '' },
      backup: { passphrase: '', dir: '', keep: 14, intervalHours: 24 },
      personalBackup: { remote: options.remoteBackups ?? true, allowPrivate: options.allowPrivate ?? false },
      mail: { host: options.mail ? 'smtp.test' : '', port: 587, user: '', password: '', from: 'Vault <vault@vault.test>', signInNotices: true },
      db: {
        driver: 'mysql',
        ssl: false,
        path: '',
        host: '127.0.0.1',
        user: 'vault',
        password: 'not-used-by-the-in-memory-store',
        database: 'vault',
        port: 3306,
      },
      pepper: 'test-pepper-not-a-real-secret',
      tokenKey: 'test-token-key-not-a-real-secret',
    },
    now: () => now,
    ...(options.mail ? { mailer: { send: async (m: Message) => { outbox.push(m) } } } : {}),
    allowRegistration: options.allowRegistration ?? true,
    adminDigests: new Set((options.adminEmails ?? []).map((e) => emailDigest(e, 'test-pepper-not-a-real-secret'))),
    ...(options.siteOutput
      ? { site: { sourceDir: join(process.cwd(), '../../apps/site'), outputDir: options.siteOutput, origin: 'https://vault.test' } }
      : {}),
  }

  const request = async (method: string, path: string, opts: RequestOptions = {}): Promise<Parsed> => {
    const event: LambdaEvent = {
      rawPath: path,
      headers: {
        ...(opts.token ? { [AUTH_HEADER]: `Bearer ${opts.token}` } : {}),
        ...(opts.rawHeaders ?? {}),
      },
      requestContext: {
        http: { method, sourceIp: opts.ip ?? '203.0.113.7', userAgent: 'test-agent' },
      },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    }
    const res: LambdaResponse = await dispatch(app, event)
    return {
      status: res.statusCode,
      headers: res.headers,
      body: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {},
    }
  }

  return { app, store, outbox, request, setNow: (ms) => { now = ms } }
}

/** Deterministic stand-in bytes.
 *
 *  Derived from a label rather than filled with a constant. A buffer of
 *  repeated bytes encodes to a repeating base64 string, and two such strings
 *  overlap as substrings of one another — which quietly defeats any test
 *  asserting that one stored value does not contain another. That is exactly
 *  the assertion protecting the claim that the auth key is never stored.
 */
export function fixtureBytes(label: string, length = 32): Buffer {
  const out = Buffer.alloc(length)
  let block = createHash('sha256').update(label).digest()
  for (let i = 0; i < length; i += 32) {
    block.copy(out, i, 0, Math.min(32, length - i))
    block = createHash('sha256').update(block).digest()
  }
  return out
}

export const fixtureB64 = (label: string, length = 32): string =>
  fixtureBytes(label, length).toString('base64url')

export function sealedBlob(label = 'blob', size = 64): string {
  return `v1.${fixtureB64(`${label}.iv`, 12)}.${fixtureB64(`${label}.body`, size)}`
}

/** A registration payload with valid shapes. The cryptographic values are not
 *  derived here — these routes never inspect them, they store them. */
export function registration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    email: 'person@example.com',
    authKey: fixtureB64('auth-key'),
    recoveryAuthKey: fixtureB64('recovery-auth-key'),
    kdf: {
      algorithm: 'PBKDF2-HMAC-SHA256',
      iterations: 600_000,
      salt: fixtureB64('kdf-salt'),
    },
    wrappedVaultKey: sealedBlob('wrapped-vault-key', 48),
    wrappedVaultKeyForRecovery: sealedBlob('wrapped-for-recovery', 48),
    ...overrides,
  }
}
