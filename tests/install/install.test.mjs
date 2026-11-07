// deploy/install.sh, in dry-run mode: the questions' answers become a
// correct .env with fresh secrets, readable by its owner only; bad answers
// are refused; running it again never overwrites the configuration.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('../../', import.meta.url).pathname
const SCRIPT = join(ROOT, 'deploy/install.sh')

function checkout() {
  const dir = mkdtempSync(join(tmpdir(), 'vault-install-'))
  cpSync(join(ROOT, 'deploy'), join(dir, 'deploy'), { recursive: true })
  return dir
}

function run(env) {
  const r = spawnSync('sh', [SCRIPT], {
    env: { PATH: process.env.PATH, HOME: tmpdir(), VAULT_DRY_RUN: '1', VAULT_YES: '1', ...env },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { code: r.status, out: r.stdout + r.stderr }
}

const readEnv = (file) => Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))

test('the script is valid POSIX sh', () => {
  assert.equal(spawnSync('sh', ['-n', SCRIPT]).status, 0)
})

test('personal: writes .env with the answers and a fresh backup passphrase, mode 600', () => {
  const dir = checkout()
  try {
    const r = run({ VAULT_DIR: dir, VAULT_HOSTNAME: 'vault.example.org' })
    assert.equal(r.code, 0, r.out)
    const file = join(dir, 'deploy/personal/.env')
    const env = readEnv(file)
    assert.equal(env.VAULT_HOSTNAME, 'vault.example.org')
    assert.equal(env.ADMIN_EMAILS, undefined, 'the owner comes from the setup link, not configuration')
    assert.match(env.BACKUP_PASSPHRASE, /^[A-Za-z0-9]{24,}$/)
    assert.equal(env.POSTGRES_PASSWORD, undefined)
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.match(r.out, /Dry run: files written, nothing started/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('business: also a database password; secrets differ every install', () => {
  const a = checkout(), b = checkout()
  try {
    for (const dir of [a, b]) assert.equal(run({ VAULT_DIR: dir, VAULT_PROFILE: 'business', VAULT_HOSTNAME: 'vault.example.org' }).code, 0)
    const ea = readEnv(join(a, 'deploy/business/.env')), eb = readEnv(join(b, 'deploy/business/.env'))
    assert.match(ea.POSTGRES_PASSWORD, /^[A-Za-z0-9]{24,}$/)
    assert.notEqual(ea.POSTGRES_PASSWORD, eb.POSTGRES_PASSWORD)
    assert.notEqual(ea.BACKUP_PASSPHRASE, eb.BACKUP_PASSPHRASE)
    assert.notEqual(ea.POSTGRES_PASSWORD, ea.BACKUP_PASSPHRASE)
  } finally {
    rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true })
  }
})

test('running it again keeps the existing configuration', () => {
  const dir = checkout()
  try {
    run({ VAULT_DIR: dir, VAULT_HOSTNAME: 'vault.example.org' })
    const file = join(dir, 'deploy/personal/.env')
    writeFileSync(file, readFileSync(file, 'utf8') + 'SMTP_HOST=smtp.example.org\n')
    const before = readFileSync(file, 'utf8')
    const r = run({ VAULT_DIR: dir, VAULT_HOSTNAME: 'other.example.org' })
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /Keeping the existing/)
    assert.equal(readFileSync(file, 'utf8'), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('bad answers are refused before anything is written', () => {
  const dir = checkout()
  try {
    for (const [env, msg] of [
      [{ VAULT_HOSTNAME: 'not a host' }, /is not a host name/],
      [{ VAULT_HOSTNAME: 'vault.example.org; rm -rf /' }, /is not a host name/],
      [{ VAULT_HOSTNAME: 'http://vault.example.org' }, /is not a host name/],
      [{ VAULT_HOSTNAME: 'vault.example.org', VAULT_PROFILE: 'enterprise' }, /personal or business/],
    ]) {
      const r = run({ VAULT_DIR: dir, ...env })
      assert.notEqual(r.code, 0, JSON.stringify(env))
      assert.match(r.out, msg)
    }
    assert.throws(() => statSync(join(dir, 'deploy/personal/.env')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('localhost is accepted for trying it out', () => {
  const dir = checkout()
  try {
    assert.equal(run({ VAULT_DIR: dir, VAULT_HOSTNAME: 'localhost' }).code, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
