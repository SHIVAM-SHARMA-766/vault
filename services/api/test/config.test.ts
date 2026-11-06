// The configuration module: every problem reported at once, no installation-
// specific defaults, and docs/configuration.md listing every variable.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { VARIABLES, parseConfig } from '../src/config.js'

const good = {
  VAULT_HOSTNAME: 'vault.example.com',
  DB_HOST: '10.0.0.5',
  DB_PASSWORD: 'db-password',
  SERVER_PEPPER: 'p'.repeat(20) + 'q'.repeat(20),
  TOKEN_SIGNING_KEY: 'k'.repeat(44),
}

test('a minimal configuration gets its defaults', () => {
  const c = parseConfig(good, '/srv/vault/api')
  assert.equal(c.origin, 'https://vault.example.com')
  assert.equal(c.port, 3000)
  assert.deepEqual(c.db, { host: '10.0.0.5', user: 'vault', password: 'db-password', database: 'vault', port: 3306 })
  assert.equal(c.allowRegistration, false)
  assert.deepEqual(c.adminEmails, [])
  assert.deepEqual(c.site, { sourceDir: '/srv/vault/api/site', outputDir: '/srv/vault/site' })
})

test('SITE_ORIGIN overrides the hostname, and admin addresses are split', () => {
  const c = parseConfig({ ...good, SITE_ORIGIN: 'http://localhost:8080/ignored-path', ADMIN_EMAILS: ' a@x.test, b@x.test ,', ALLOW_REGISTRATION: 'true' })
  assert.equal(c.origin, 'http://localhost:8080')
  assert.deepEqual(c.adminEmails, ['a@x.test', 'b@x.test'])
  assert.equal(c.allowRegistration, true)
})

test('every problem is reported at once, and there is no default address', () => {
  assert.throws(() => parseConfig({ SERVER_PEPPER: 'short', TOKEN_SIGNING_KEY: 'changeme'.padEnd(40, 'x'), PORT: 'abc' }), (e: Error) => {
    for (const s of ['DB_HOST is required', 'DB_PASSWORD is required', 'SERVER_PEPPER is too short', 'TOKEN_SIGNING_KEY still holds a placeholder', 'PORT must be a port number', 'VAULT_HOSTNAME (or SITE_ORIGIN) is required']) {
      assert.ok(e.message.includes(s), `missing: ${s}\n${e.message}`)
    }
    return true
  })
})

test('docs/configuration.md lists every variable', () => {
  const doc = readFileSync(join(process.cwd(), '../../docs/configuration.md'), 'utf8')
  for (const v of VARIABLES) assert.ok(doc.includes(`\`${v.name}\``), `${v.name} is not documented`)
})

test('only server.ts knows which database is behind the Store interface', async () => {
  const { readdirSync } = await import('node:fs')
  const src = join(process.cwd(), 'src')
  const files = [...readdirSync(src).map((f) => f), ...readdirSync(join(src, 'routes')).map((f) => `routes/${f}`)]
    .filter((f) => f.endsWith('.ts') && f !== 'store-mysql.ts' && f !== 'server.ts')
  for (const f of files) {
    const text = readFileSync(join(src, f), 'utf8')
    assert.ok(!/store-mysql|mysql2|\b(SELECT|INSERT|UPDATE|DELETE)\s+(\*|INTO|FROM|\w+\s+SET)/.test(text), `${f} reaches past the Store interface`)
  }
})
