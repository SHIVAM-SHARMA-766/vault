// SQLite, behind the same interface as every other store. For the personal
// install profile (phase 2): one file, no database server, small enough for a
// Raspberry Pi. One process owns the file; WAL mode lets reads continue while
// a write commits, and busy_timeout waits out a backup holding a lock.

import { AlreadyExists, type Item, type Store } from '../store.js'
import { META_TABLE, pending } from './migrations.js'

type Database = import('better-sqlite3').Database

const fromRow = (row: { pk: string; sk: string; data: string }): Item => ({ pk: row.pk, sk: row.sk, ...(JSON.parse(row.data) as Record<string, unknown>) })
const toJson = ({ pk: _pk, sk: _sk, ...rest }: Item): string => JSON.stringify(rest)

export class SqliteStore implements Store {
  private constructor(private readonly db: Database) {}

  /** `path` is a file, or ":memory:" for tests. */
  static async open(path: string): Promise<SqliteStore> {
    const { default: Sqlite } = await import('better-sqlite3')
    const db = new Sqlite(path)
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('busy_timeout = 5000')
    db.pragma('foreign_keys = ON')
    return new SqliteStore(db)
  }

  /** `target` stops at an earlier version; tests use it to build old databases. */
  async migrate(target?: number): Promise<number> {
    this.db.exec(META_TABLE.sqlite)
    const row = this.db.prepare("SELECT v FROM vault_meta WHERE k = 'schema_version'").get() as { v: string } | undefined
    let version = Number(row?.v ?? 0)
    for (const m of pending(version, target)) {
      // IMMEDIATE takes the write lock up front, so two processes cannot both
      // decide to run the same migration.
      this.db.transaction(() => {
        for (const sql of m.sql.sqlite) this.db.exec(sql)
        this.db.prepare("INSERT INTO vault_meta (k, v) VALUES ('schema_version', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(String(m.version))
      }).immediate()
      version = m.version
    }
    return version
  }

  async get(pk: string, sk: string): Promise<Item | null> {
    const row = this.db.prepare('SELECT pk, sk, data FROM vault WHERE pk = ? AND sk = ?').get(pk, sk) as { pk: string; sk: string; data: string } | undefined
    return row ? fromRow(row) : null
  }

  async put(item: Item, opts: { mustNotExist?: boolean } = {}): Promise<void> {
    const expiresAt = typeof item['expiresAt'] === 'number' ? item['expiresAt'] : null
    if (opts.mustNotExist) {
      const res = this.db.prepare('INSERT INTO vault (pk, sk, data, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT (pk, sk) DO NOTHING')
        .run(item.pk, item.sk, toJson(item), expiresAt)
      if (res.changes === 0) throw new AlreadyExists()
      return
    }
    this.db.prepare(`INSERT INTO vault (pk, sk, data, expires_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (pk, sk) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`)
      .run(item.pk, item.sk, toJson(item), expiresAt)
  }

  async delete(pk: string, sk: string): Promise<void> {
    this.db.prepare('DELETE FROM vault WHERE pk = ? AND sk = ?').run(pk, sk)
  }

  /** The prefix is compared with substr rather than LIKE: SQLite's LIKE is
   *  case-insensitive for ASCII, which would let "entry#" match "ENTRY#". */
  async query(pk: string, skPrefix?: string): Promise<Item[]> {
    const rows = (skPrefix
      ? this.db.prepare('SELECT pk, sk, data FROM vault WHERE pk = ? AND substr(sk, 1, length(?)) = ? ORDER BY sk').all(pk, skPrefix, skPrefix)
      : this.db.prepare('SELECT pk, sk, data FROM vault WHERE pk = ? ORDER BY sk').all(pk)) as { pk: string; sk: string; data: string }[]
    return rows.map(fromRow)
  }

  async increment(pk: string, sk: string, expiresAt: number): Promise<number> {
    const row = this.db.prepare(`INSERT INTO vault (pk, sk, data, expires_at) VALUES (?, ?, '{"count":1}', ?)
      ON CONFLICT (pk, sk) DO UPDATE SET data = json_set(vault.data, '$.count', COALESCE(json_extract(vault.data, '$.count'), 0) + 1)
      RETURNING json_extract(data, '$.count') AS count`).get(pk, sk, expiresAt) as { count: number }
    return Number(row.count)
  }

  async scan(): Promise<Item[]> {
    return (this.db.prepare('SELECT pk, sk, data FROM vault ORDER BY pk, sk').all() as { pk: string; sk: string; data: string }[]).map(fromRow)
  }

  async sweepExpired(now = Math.floor(Date.now() / 1000)): Promise<number> {
    return this.db.prepare('DELETE FROM vault WHERE expires_at IS NOT NULL AND expires_at < ?').run(now).changes
  }

  /** A consistent copy of the whole database, safe while the server runs.
   *  Used by the backup job in place of mysqldump. */
  async backupTo(path: string): Promise<void> {
    await this.db.backup(path)
  }

  async close(): Promise<void> {
    this.db.close()
  }
}
