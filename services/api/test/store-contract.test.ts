// One contract, every implementation.
//
// The routes are tested against the in-memory store, which is only honest if
// that store behaves like the real one. These tests state the behaviour both
// must have and run them against each — so a difference between them shows up
// here rather than in production.
//
// SQLite always runs (it needs no server). MySQL runs when DB_HOST is set and
// PostgreSQL when PG_HOST is set, as they are in CI. Skipping is deliberate: a
// test that needs a database server should not stop someone running the suite
// without one.

import test from 'node:test'
import assert from 'node:assert/strict'

import type { Item, Store } from '../src/store.js'
import { AlreadyExists } from '../src/store.js'
import { MemoryStore } from './harness.js'

interface Candidate {
  name: string
  make: () => Promise<{ store: Store; done: () => Promise<void> }>
}

const candidates: Candidate[] = [
  {
    name: 'in-memory',
    make: async () => ({ store: new MemoryStore(), done: async () => {} }),
  },
]

if (process.env['DB_HOST']) {
  candidates.push({
    name: 'mysql',
    make: async () => {
      const { MysqlStore } = await import('../src/store-mysql.js')
      const store = new MysqlStore({
        host: process.env['DB_HOST']!,
        user: process.env['DB_USER'] ?? 'root',
        password: process.env['DB_PASSWORD'] ?? '',
        database: process.env['DB_NAME'] ?? 'vault',
        port: Number(process.env['DB_PORT'] ?? 3306),
      })
      await store.migrate()
      // Each run starts from nothing, so an earlier failure cannot make a
      // later one pass.
      for (const pk of ['USER#a', 'USER#b', 'RATE#t']) {
        for (const item of await store.query(pk)) await store.delete(item.pk, item.sk)
      }
      return { store, done: () => store.close() }
    },
  })
}

candidates.push({
  name: 'sqlite',
  make: async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { SqliteStore } = await import('../src/storage/sqlite.js')
    const dir = mkdtempSync(join(tmpdir(), 'vault-sqlite-'))
    const store = await SqliteStore.open(join(dir, 'vault.db'))
    await store.migrate()
    return { store, done: async () => { await store.close(); rmSync(dir, { recursive: true, force: true }) } }
  },
})

if (process.env['PG_HOST']) {
  candidates.push({
    name: 'postgres',
    make: async () => {
      const { PostgresStore } = await import('../src/storage/postgres.js')
      const store = await PostgresStore.open({
        host: process.env['PG_HOST']!, port: Number(process.env['PG_PORT'] ?? 5432),
        user: process.env['PG_USER'] ?? 'postgres', password: process.env['PG_PASSWORD'] ?? '', database: process.env['PG_DATABASE'] ?? 'vault',
      })
      await store.migrate()
      for (const pk of ['USER#a', 'USER#b', 'RATE#t']) {
        for (const item of await store.query(pk)) await store.delete(item.pk, item.sk)
      }
      return { store, done: () => store.close() }
    },
  })
}

const entry = (sk: string, extra: Record<string, unknown> = {}): Item => ({
  pk: 'USER#a',
  sk,
  blob: `v1.AAAA.${sk}`,
  ...extra,
})

for (const candidate of candidates) {
  test(`${candidate.name}: round-trips an item`, async () => {
    const { store, done } = await candidate.make()
    try {
      await store.put(entry('ENTRY#1', { createdAt: 'now', n: 42, flag: true }))
      const got = await store.get('USER#a', 'ENTRY#1')
      assert.ok(got)
      assert.equal(got.blob, 'v1.AAAA.ENTRY#1')
      assert.equal(got.n, 42, 'numbers survive')
      assert.equal(got.flag, true, 'booleans survive')
    } finally {
      await done()
    }
  })

  test(`${candidate.name}: a missing item is null, not an error`, async () => {
    const { store, done } = await candidate.make()
    try {
      assert.equal(await store.get('USER#a', 'NOPE#1'), null)
    } finally {
      await done()
    }
  })

  test(`${candidate.name}: put overwrites, mustNotExist refuses`, async () => {
    const { store, done } = await candidate.make()
    try {
      await store.put(entry('ENTRY#1', { v: 1 }))
      await store.put(entry('ENTRY#1', { v: 2 }))
      assert.equal((await store.get('USER#a', 'ENTRY#1'))?.['v'], 2, 'overwrites')

      await assert.rejects(
        () => store.put(entry('ENTRY#1', { v: 3 }), { mustNotExist: true }),
        AlreadyExists,
        'refuses when it already exists',
      )
      assert.equal((await store.get('USER#a', 'ENTRY#1'))?.['v'], 2, 'and changed nothing')
    } finally {
      await done()
    }
  })

  test(`${candidate.name}: query returns one partition, sorted, prefix-filtered`, async () => {
    const { store, done } = await candidate.make()
    try {
      await store.put(entry('ENTRY#2'))
      await store.put(entry('ENTRY#1'))
      await store.put(entry('FOLDER#1'))
      await store.put({ pk: 'USER#b', sk: 'ENTRY#9', blob: 'v1.AAAA.other' })

      const all = await store.query('USER#a')
      assert.deepEqual(all.map((i) => i.sk), ['ENTRY#1', 'ENTRY#2', 'FOLDER#1'], 'sorted by sk')

      const entries = await store.query('USER#a', 'ENTRY#')
      assert.deepEqual(entries.map((i) => i.sk), ['ENTRY#1', 'ENTRY#2'])

      const other = await store.query('USER#b')
      assert.equal(other.length, 1, "another partition is not visible")
    } finally {
      await done()
    }
  })

  test(`${candidate.name}: a prefix containing wildcards matches literally`, async () => {
    // Only meaningful against SQL, where the prefix becomes a LIKE pattern —
    // but the in-memory store has to agree, or the tests built on it lie.
    const { store, done } = await candidate.make()
    try {
      await store.put({ pk: 'USER#a', sk: 'A%B#1', blob: 'v1.AAAA.pct' })
      await store.put({ pk: 'USER#a', sk: 'AXB#1', blob: 'v1.AAAA.other' })

      const got = await store.query('USER#a', 'A%B')
      assert.deepEqual(got.map((i) => i.sk), ['A%B#1'], '% is not a wildcard')
    } finally {
      await done()
    }
  })

  test(`${candidate.name}: delete removes exactly one item`, async () => {
    const { store, done } = await candidate.make()
    try {
      await store.put(entry('ENTRY#1'))
      await store.put(entry('ENTRY#2'))
      await store.delete('USER#a', 'ENTRY#1')
      assert.equal(await store.get('USER#a', 'ENTRY#1'), null)
      assert.ok(await store.get('USER#a', 'ENTRY#2'))
      // Deleting something absent is not an error.
      await store.delete('USER#a', 'ENTRY#1')
    } finally {
      await done()
    }
  })

  test(`${candidate.name}: increment counts up from nothing`, async () => {
    const { store, done } = await candidate.make()
    try {
      const expiresAt = Math.floor(Date.now() / 1000) + 900
      assert.equal(await store.increment('RATE#t', 'w1', expiresAt), 1)
      assert.equal(await store.increment('RATE#t', 'w1', expiresAt), 2)
      assert.equal(await store.increment('RATE#t', 'w1', expiresAt), 3)
      assert.equal(await store.increment('RATE#t', 'w2', expiresAt), 1, 'separate windows')
    } finally {
      await done()
    }
  })

  test(`${candidate.name}: a prefix is case-sensitive`, async () => {
    const { store, done } = await candidate.make()
    try {
      await store.put({ pk: 'USER#a', sk: 'ENTRY#1', blob: 'v1.AAAA.upper' })
      assert.deepEqual((await store.query('USER#a', 'entry#')).map((i) => i.sk), [], 'lower case does not match ENTRY#')
    } finally {
      await done()
    }
  })

  test(`${candidate.name}: concurrent increments lose nothing`, async () => {
    // The rate limiter is the one place a lost update would matter: it is what
    // stands between an attacker and unlimited guesses.
    const { store, done } = await candidate.make()
    try {
      const expiresAt = Math.floor(Date.now() / 1000) + 900
      const results = await Promise.all(
        Array.from({ length: 20 }, () => store.increment('RATE#t', 'race', expiresAt)),
      )
      const final = Math.max(...results)
      assert.equal(final, 20, `counted every call, saw ${results.sort((a, b) => a - b).join(',')}`)
    } finally {
      await done()
    }
  })
}
