// MySQL, behind the same five-method interface the in-memory store implements.
//
// The vault lives in one table of three columns: a shard key, a sort key, and
// a JSON document. The server cannot interpret the document, so giving it a
// schema would be a schema it could not enforce.
//
// The database is reachable only from inside this project's VCN, which holds
// exactly one host. It is not on the internet.

import { createConnection, createPool, type Pool, type RowDataPacket } from 'mysql2/promise'

import { AlreadyExists, type Item, type ManagedStore } from './store.js'
import { META_TABLE, pending } from './storage/migrations.js'

export interface MysqlConfig {
  host: string
  user: string
  password: string
  database: string
  port?: number
}

interface Row extends RowDataPacket {
  pk: string
  sk: string
  data: Record<string, unknown> | string
}

const fromRow = (row: Row): Item => {
  const data = typeof row.data === 'string' ? (JSON.parse(row.data) as Record<string, unknown>) : row.data
  return { pk: row.pk, sk: row.sk, ...data }
}

const toJson = (item: Item): string => {
  const { pk: _pk, sk: _sk, ...rest } = item
  return JSON.stringify(rest)
}

/** Escapes the characters LIKE treats as wildcards, so a sort-key prefix
 *  containing `%` or `_` matches literally rather than matching everything. */
const likePrefix = (prefix: string): string =>
  `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`


/** Rows that carry an expiry remove themselves. MySQL has no per-row time to
 *  live, so a scheduled event does the work instead — which is why the column
 *  is separate from the JSON document and indexed. */
export const CLEANUP_EVENT = `
CREATE EVENT IF NOT EXISTS vault_expire
ON SCHEDULE EVERY 15 MINUTE
DO DELETE FROM vault WHERE expires_at IS NOT NULL AND expires_at < UNIX_TIMESTAMP()
`

export class MysqlStore implements ManagedStore {
  private readonly pool: Pool
  private readonly config: MysqlConfig

  constructor(config: MysqlConfig) {
    this.config = config
    this.pool = createPool({
      host: config.host,
      port: config.port ?? 3306,
      user: config.user,
      password: config.password,
      database: config.database,

      // One user on a one-core host. A large pool would buy nothing and would
      // hold connections the database counts against its own limits.
      connectionLimit: 4,
      waitForConnections: true,
      queueLimit: 32,

      // Without these a database that stops answering turns every request into
      // one that hangs rather than one that fails, and on a single-core host a
      // hung request stops the process answering anything.
      connectTimeout: 5000,

      // The driver would otherwise return DECIMAL and BIGINT as strings in some
      // cases and numbers in others.
      supportBigNumbers: true,
      bigNumberStrings: false,
    })
  }

  /** Creates the schema, the table, and the expiry event. Idempotent, and run
   *  on every start, so a fresh server needs no manual step.
   *
   *  The database itself has to come first and cannot come from the pool: a
   *  managed MySQL is handed over with a server and an admin user but no
   *  schema, and every connection in the pool names one. Without this the
   *  service fails at boot with "Unknown database", which reads like a
   *  configuration error rather than an empty server. */
  /** `target` stops at an earlier version; tests use it to build old databases. */
  async migrate(target?: number): Promise<number> {
    const bootstrap = await createConnection({
      host: this.config.host,
      port: this.config.port ?? 3306,
      user: this.config.user,
      password: this.config.password,
      connectTimeout: 5000,
    })
    try {
      // The name is ours, not user input, but it is still interpolated into
      // DDL — so it is checked rather than trusted.
      if (!/^[A-Za-z0-9_]+$/.test(this.config.database)) {
        throw new Error(`refusing to create a database named ${this.config.database}`)
      }
      await bootstrap.query(
        `CREATE DATABASE IF NOT EXISTS \`${this.config.database}\` ` +
          'CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
      )
    } finally {
      await bootstrap.end()
    }

    // Versioned migrations (storage/migrations.ts), under a named lock so two
    // starting servers cannot both run one. Version 1 adopts a table created
    // before migrations were versioned.
    const conn = await this.pool.getConnection()
    let version = 0
    try {
      await conn.query("SELECT GET_LOCK('vault_migrate', 30)")
      await conn.query(META_TABLE.mysql)
      const [meta] = await conn.query<RowDataPacket[]>("SELECT v FROM vault_meta WHERE k = 'schema_version'")
      version = Number(meta[0]?.['v'] ?? 0)
      for (const m of pending(version, target)) {
        // MySQL commits DDL implicitly, so each step must be idempotent on its
        // own; the version is recorded after all of its statements succeed.
        for (const sql of m.sql.mysql) await conn.query(sql)
        await conn.query("INSERT INTO vault_meta (k, v) VALUES ('schema_version', ?) ON DUPLICATE KEY UPDATE v = VALUES(v)", [String(m.version)])
        version = m.version
      }
    } finally {
      await conn.query("SELECT RELEASE_LOCK('vault_migrate')").catch(() => {})
      conn.release()
    }

    try {
      await this.pool.query(CLEANUP_EVENT)

      // Turning the scheduler on needs SUPER, which a managed MySQL does not
      // grant — and does not need to, because it ships with the scheduler
      // already running. Only attempt it when it is actually off, so the
      // common case does not log a permission error that means nothing. A
      // warning that always appears and never matters is how warnings stop
      // being read.
      const [rows] = await this.pool.query<RowDataPacket[]>(
        "SHOW GLOBAL VARIABLES LIKE 'event_scheduler'",
      )
      const running = String(rows[0]?.['Value'] ?? '').toUpperCase() === 'ON'
      if (!running) {
        await this.pool.query('SET GLOBAL event_scheduler = ON')
      }
    } catch (err) {
      // Without the event, rows carrying an expiry are never removed: sessions
      // and activity records accumulate until someone notices. That is a
      // degraded vault rather than a broken one, so it warns instead of
      // refusing to start — but it does need attention. See docs/runbook.md.
      console.warn('the expiry event could not be created; the server sweeps expired rows itself instead:', (err as Error).message)
    }
    return version
  }

  async scan(): Promise<Item[]> {
    const [rows] = await this.pool.query<Row[]>('SELECT pk, sk, data FROM vault ORDER BY pk, sk')
    return rows.map(fromRow)
  }

  async sweepExpired(now = Math.floor(Date.now() / 1000)): Promise<number> {
    const [res] = await this.pool.query('DELETE FROM vault WHERE expires_at IS NOT NULL AND expires_at < ?', [now])
    return (res as { affectedRows?: number }).affectedRows ?? 0
  }

  async get(pk: string, sk: string): Promise<Item | null> {
    const [rows] = await this.pool.query<Row[]>(
      'SELECT pk, sk, data FROM vault WHERE pk = ? AND sk = ?',
      [pk, sk],
    )
    return rows.length ? fromRow(rows[0]!) : null
  }

  async put(item: Item, opts: { mustNotExist?: boolean } = {}): Promise<void> {
    const expiresAt = typeof item['expiresAt'] === 'number' ? item['expiresAt'] : null

    if (opts.mustNotExist) {
      // A plain INSERT, so a duplicate registration loses in the database
      // rather than in a read-then-write race between two requests.
      try {
        await this.pool.query(
          'INSERT INTO vault (pk, sk, data, expires_at) VALUES (?, ?, CAST(? AS JSON), ?)',
          [item.pk, item.sk, toJson(item), expiresAt],
        )
      } catch (err) {
        if ((err as { code?: string }).code === 'ER_DUP_ENTRY') throw new AlreadyExists()
        throw err
      }
      return
    }

    await this.pool.query(
      `INSERT INTO vault (pk, sk, data, expires_at) VALUES (?, ?, CAST(? AS JSON), ?)
       ON DUPLICATE KEY UPDATE data = VALUES(data), expires_at = VALUES(expires_at)`,
      [item.pk, item.sk, toJson(item), expiresAt],
    )
  }

  async delete(pk: string, sk: string): Promise<void> {
    await this.pool.query('DELETE FROM vault WHERE pk = ? AND sk = ?', [pk, sk])
  }

  /** Everything in one partition, optionally narrowed by a sort-key prefix.
   *  Both forms are covered by the primary key, so neither scans the table. */
  async query(pk: string, skPrefix?: string): Promise<Item[]> {
    const [rows] = skPrefix
      ? await this.pool.query<Row[]>(
          "SELECT pk, sk, data FROM vault WHERE pk = ? AND sk LIKE ? ESCAPE '\\\\' ORDER BY sk",
          [pk, likePrefix(skPrefix)],
        )
      : await this.pool.query<Row[]>(
          'SELECT pk, sk, data FROM vault WHERE pk = ? ORDER BY sk',
          [pk],
        )
    return rows.map(fromRow)
  }

  /** A rate-limit window. One statement, atomic in the database, with no
   *  read-modify-write and no retry loop — the counter cannot lose a race. */
  async increment(pk: string, sk: string, expiresAt: number): Promise<number> {
    await this.pool.query(
      `INSERT INTO vault (pk, sk, data, expires_at)
       VALUES (?, ?, JSON_OBJECT('count', 1), ?)
       ON DUPLICATE KEY UPDATE
         data = JSON_SET(data, '$.count', JSON_EXTRACT(data, '$.count') + 1)`,
      [pk, sk, expiresAt],
    )
    const [rows] = await this.pool.query<Row[]>(
      'SELECT pk, sk, data FROM vault WHERE pk = ? AND sk = ?',
      [pk, sk],
    )
    const item = rows.length ? fromRow(rows[0]!) : null
    return Number(item?.['count'] ?? 1)
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
