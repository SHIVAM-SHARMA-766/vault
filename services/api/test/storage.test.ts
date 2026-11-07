// Migrations and expiry, for every SQL driver that can run here.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseConfig } from '../src/config.js'
import { LATEST_VERSION, MIGRATIONS, pending } from '../src/storage/migrations.js'
import { SqliteStore } from '../src/storage/sqlite.js'
import { openStore } from '../src/storage/index.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'vault-storage-'))

test('migrations are numbered 1, 2, 3… and every one covers every driver', () => {
  MIGRATIONS.forEach((m, i) => {
    assert.equal(m.version, i + 1)
    for (const d of ['mysql', 'postgres', 'sqlite'] as const) assert.ok(m.sql[d].length, `${m.version} has no ${d} statements`)
  })
  assert.deepEqual(pending(LATEST_VERSION), [])
  assert.throws(() => pending(LATEST_VERSION + 1), /newer than this server/)
})

test('sqlite: migrates from empty, is idempotent, and keeps data across reopen', async () => {
  const dir = tmp()
  try {
    const file = join(dir, 'v.db')
    let store = await SqliteStore.open(file)
    assert.equal(await store.migrate(), LATEST_VERSION)
    assert.equal(await store.migrate(), LATEST_VERSION, 'running again changes nothing')
    await store.put({ pk: 'USER#a', sk: 'ENTRY#1', blob: 'v1.x.y' })
    await store.close()
    store = await SqliteStore.open(file)
    assert.equal(await store.migrate(), LATEST_VERSION)
    assert.equal((await store.get('USER#a', 'ENTRY#1'))?.['blob'], 'v1.x.y')
    await store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sqlite: expired rows are swept, live ones kept', async () => {
  const dir = tmp()
  try {
    const store = await SqliteStore.open(join(dir, 'v.db'))
    await store.migrate()
    await store.put({ pk: 'USER#a', sk: 'SESSION#old', expiresAt: 1000 })
    await store.put({ pk: 'USER#a', sk: 'SESSION#new', expiresAt: 4_000_000_000 })
    await store.put({ pk: 'USER#a', sk: 'ENTRY#1', blob: 'v1.x.y' })
    assert.equal(await store.sweepExpired(2000), 1)
    assert.deepEqual((await store.query('USER#a')).map((i) => i.sk), ['ENTRY#1', 'SESSION#new'])
    await store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sqlite: an online backup is a complete, openable copy', async () => {
  const dir = tmp()
  try {
    const store = await SqliteStore.open(join(dir, 'live.db'))
    await store.migrate()
    for (let i = 0; i < 50; i++) await store.put({ pk: 'USER#a', sk: `ENTRY#${String(i).padStart(3, '0')}`, blob: `v1.${i}.x` })
    await store.backupTo(join(dir, 'copy.db'))
    await store.close()
    const copy = await SqliteStore.open(join(dir, 'copy.db'))
    assert.equal(await copy.migrate(), LATEST_VERSION)
    assert.equal((await copy.query('USER#a', 'ENTRY#')).length, 50)
    await copy.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the configuration picks the driver, and asks only for what it needs', async () => {
  const secrets = { VAULT_HOSTNAME: 'v.example', SERVER_PEPPER: 'p'.repeat(40), TOKEN_SIGNING_KEY: 'k'.repeat(40) }
  const dir = tmp()
  try {
    const sqlite = parseConfig({ ...secrets, DB_DRIVER: 'sqlite', DB_PATH: join(dir, 'x.db') })
    assert.equal(sqlite.db.driver, 'sqlite')
    const store = await openStore(sqlite)
    assert.equal(await store.migrate(), LATEST_VERSION)
    await store.close()

    assert.equal(parseConfig({ ...secrets, DB_DRIVER: 'postgres', DB_HOST: 'db', DB_PASSWORD: 'x' }).db.port, 5432)
    assert.equal(parseConfig({ ...secrets, DB_HOST: 'db', DB_PASSWORD: 'x' }).db.port, 3306, 'mysql stays the default')
    assert.throws(() => parseConfig({ ...secrets, DB_DRIVER: 'postgres' }), /DB_HOST is required for postgres/)
    assert.throws(() => parseConfig({ ...secrets, DB_DRIVER: 'oracle' }), /DB_DRIVER must be/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a database left at every earlier schema version upgrades to the latest with its data intact', async () => {
  for (let from = 1; from < LATEST_VERSION; from++) {
    const dir = tmp()
    try {
      const file = join(dir, 'old.db')
      const old = await SqliteStore.open(file)
      assert.equal(await old.migrate(from), from)
      await old.put({ pk: 'USER#a', sk: 'ENTRY#1', blob: 'v1.old.data' })
      await old.put({ pk: 'SYSTEM', sk: 'SETTINGS', registration: 'invite' })
      await old.close()

      const upgraded = await SqliteStore.open(file)
      assert.equal(await upgraded.migrate(), LATEST_VERSION, `from ${from}`)
      assert.equal((await upgraded.get('USER#a', 'ENTRY#1'))?.['blob'], 'v1.old.data')
      assert.equal((await upgraded.get('SYSTEM', 'SETTINGS'))?.['registration'], 'invite')
      await upgraded.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})
