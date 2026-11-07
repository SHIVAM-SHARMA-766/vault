// Backups: the file format, scheduled runs, restore onto any driver, and the
// S3 signer — checked against AWS's own published example, and against a
// real S3-compatible server when S3_TEST_ENDPOINT is set (CI runs MinIO).

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openBackup, readHeader, restoreBackup, runBackup, sealBackup } from '../src/backup.js'
import { type Config, parseConfig } from '../src/config.js'
import { signV4 } from '../src/s3.js'
import { SqliteStore } from '../src/storage/sqlite.js'

const PASS = 'correct horse battery staple 42'
const secrets = { SERVER_PEPPER: 'p'.repeat(44), TOKEN_SIGNING_KEY: 'k'.repeat(64) }

async function sqlite(dir: string, name = 'v.db') {
  const s = await SqliteStore.open(join(dir, name))
  await s.migrate()
  return s
}

function config(dir: string, extra: Record<string, string> = {}): Config {
  return parseConfig({
    VAULT_HOSTNAME: 'v.example', DB_DRIVER: 'sqlite', DB_PATH: join(dir, 'v.db'),
    ...secrets, BACKUP_PASSPHRASE: PASS, BACKUP_DIR: join(dir, 'backups'), ...extra,
  })
}

async function seed(store: SqliteStore) {
  await store.put({ pk: 'USER#a', sk: 'PROFILE', kdf: { iterations: 600000 }, createdAt: 'x' })
  for (let i = 0; i < 30; i++) await store.put({ pk: 'USER#a', sk: `ENTRY#${String(i).padStart(3, '0')}`, blob: `v1.${i}.ct` })
  await store.put({ pk: 'SYSTEM', sk: 'SETTINGS', registration: 'invite' })
  await store.increment('RATE#auth-ip', 'w1', 4_000_000_000)
}

test('a sealed backup opens with its passphrase, and only with it', async () => {
  const file = await sealBackup({ secrets, rows: [{ pk: 'USER#a', sk: 'ENTRY#1', blob: 'v1.x.y' }] }, PASS)
  const { header, contents } = await openBackup(file, PASS)
  assert.equal(header.rows, 1)
  assert.deepEqual(contents.secrets, secrets)
  assert.equal(file.includes(Buffer.from('v1.x.y')), false, 'rows are encrypted')
  assert.equal(file.includes(Buffer.from(secrets.SERVER_PEPPER)), false, 'secrets are encrypted')
  await assert.rejects(openBackup(file, 'the wrong passphrase entirely'), /wrong passphrase/)
  await assert.rejects(sealBackup({ secrets, rows: [] }, 'short'), /at least 16/)
})

test('changing the header or one byte of the body is detected', async () => {
  const file = await sealBackup({ secrets, rows: [] }, PASS)
  const text = file.toString('latin1')
  const tamperedHeader = Buffer.from(text.replace('"rows":0', '"rows":9'), 'latin1')
  await assert.rejects(openBackup(tamperedHeader, PASS), /wrong passphrase|changed/)
  const flipped = Buffer.from(file); flipped[flipped.length - 20]! ^= 1
  await assert.rejects(openBackup(flipped, PASS), /wrong passphrase|changed/)
  assert.throws(() => readHeader(Buffer.from('not a backup')), /not a Vault backup/)
})

test('runBackup writes a private file, records it, skips rate counters, and keeps the last N', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vault-backup-'))
  try {
    const store = await sqlite(dir)
    await seed(store)
    const c = config(dir, { BACKUP_KEEP: '2' })
    const times = ['2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z', '2026-11-03T00:00:00Z']
    let last
    for (const t of times) last = await runBackup(store, c, new Date(t))
    const files = readdirSync(join(dir, 'backups')).sort()
    assert.equal(files.length, 2, 'only the newest two are kept')
    assert.equal(files[1], last!.name)
    assert.equal(statSync(join(dir, 'backups', last!.name)).mode & 0o777, 0o600)
    assert.equal(last!.rows, 32, 'profile, 30 entries, settings — no rate counter')
    assert.equal((await store.get('SYSTEM', 'BACKUP'))?.['object'], last!.name)
    await store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('restore rebuilds an identical database, returns the secrets, and refuses a non-empty one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vault-restore-'))
  try {
    const source = await sqlite(dir, 'source.db')
    await seed(source)
    const { name } = await runBackup(source, config(dir))
    const file = readFileSync(join(dir, 'backups', name))

    const target = await sqlite(dir, 'target.db')
    const { secrets: restored, header } = await restoreBackup(target, file, PASS)
    assert.deepEqual(restored, secrets)
    assert.equal(header.rows, 32)
    const strip = (rows: { pk: string; sk: string }[]) => rows.filter((r) => !r.pk.startsWith('RATE#') && r.sk !== 'BACKUP')
    assert.deepEqual(strip(await target.scan()), strip(await source.scan()))

    await assert.rejects(restoreBackup(target, file, PASS), /not empty/)
    await target.put({ pk: 'USER#z', sk: 'ENTRY#stray', blob: 'v1.a.b' })
    await restoreBackup(target, file, PASS, { force: true })
    assert.equal(await target.get('USER#z', 'ENTRY#stray'), null, '--force replaces everything')
    await source.close(); await target.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a backup from SQLite restores into PostgreSQL (when PG_HOST is set)', { skip: !process.env['PG_HOST'] }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vault-cross-'))
  const { PostgresStore } = await import('../src/storage/postgres.js')
  const pg = await PostgresStore.open({
    host: process.env['PG_HOST']!, port: Number(process.env['PG_PORT'] ?? 5432),
    user: process.env['PG_USER'] ?? 'postgres', password: process.env['PG_PASSWORD'] ?? '', database: process.env['PG_DATABASE'] ?? 'vault',
  })
  try {
    const source = await sqlite(dir)
    await seed(source)
    const { name } = await runBackup(source, config(dir))
    await pg.migrate()
    await restoreBackup(pg, readFileSync(join(dir, 'backups', name)), PASS, { force: true })
    assert.equal((await pg.query('USER#a', 'ENTRY#')).length, 30)
    assert.equal((await pg.get('SYSTEM', 'SETTINGS'))?.['registration'], 'invite')
    for (const r of await pg.scan()) await pg.delete(r.pk, r.sk)
    await source.close()
  } finally {
    await pg.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the S3 signer reproduces AWS\'s published SigV4 example', () => {
  // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html — "GET Object"
  const headers = signV4(
    { endpoint: '', region: 'us-east-1', bucket: 'examplebucket', accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
    'GET', new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    { Range: 'bytes=0-9' }, new Date('2013-05-24T00:00:00Z'),
  )
  assert.equal(headers['authorization'],
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41')
})

test('backups upload to a real S3-compatible server (when S3_TEST_ENDPOINT is set)', { skip: !process.env['S3_TEST_ENDPOINT'] }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vault-s3-'))
  try {
    const store = await sqlite(dir)
    await seed(store)
    const c = config(dir, {
      BACKUP_DIR: '', BACKUP_S3_ENDPOINT: process.env['S3_TEST_ENDPOINT']!, BACKUP_S3_BUCKET: process.env['S3_TEST_BUCKET'] ?? 'vault-test',
      BACKUP_S3_ACCESS_KEY: process.env['S3_TEST_ACCESS_KEY']!, BACKUP_S3_SECRET_KEY: process.env['S3_TEST_SECRET_KEY']!,
    })
    const s3 = c.backup.s3!
    if (process.env['S3_TEST_CREATE_BUCKET']) {
      const bucketUrl = new URL(`${s3.endpoint}/${s3.bucket}`)
      const { host: _b, ...h } = signV4(s3, 'PUT', bucketUrl, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', {}, new Date())
      await fetch(bucketUrl, { method: 'PUT', headers: h })
    }
    const { name, bytes } = await runBackup(store, c)
    // Read it back with a signed GET and open it.
    const url = new URL(`${s3.endpoint}/${s3.bucket}/${s3.prefix}${name}`)
    const { host: _h, ...headers } = signV4(s3, 'GET', url, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', {}, new Date())
    const res = await fetch(url, { headers })
    assert.equal(res.status, 200)
    const file = Buffer.from(await res.arrayBuffer())
    assert.equal(file.length, bytes)
    assert.equal((await openBackup(file, PASS)).header.rows, 32)
    await store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
