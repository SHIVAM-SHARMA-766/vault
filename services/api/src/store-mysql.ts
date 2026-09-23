// MySQL, behind the same five-method interface the in-memory store implements.
//
// The vault lives in one table of three columns: a shard key, a sort key, and
// a JSON document. The server cannot interpret the document, so giving it a
// schema would be a schema it could not enforce.
//
// The database is reachable only from inside this project's VCN, which holds
// exactly one host. It is not on the internet.

import { createPool, type Pool, type RowDataPacket } from 'mysql2/promise'

import { AlreadyExists, type Item, type Store } from './store.js'

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

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS vault (
  pk         VARCHAR(255) NOT NULL,
  sk         VARCHAR(255) NOT NULL,
  data       JSON         NOT NULL,
  expires_at BIGINT       NULL,
  PRIMARY KEY (pk, sk),
  KEY idx_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`

/** Rows that carry an expiry remove themselves. MySQL has no per-row time to
 *  live, so a scheduled event does the work instead — which is why the column
 *  is separate from the JSON document and indexed. */
export const CLEANUP_EVENT = `
CREATE EVENT IF NOT EXISTS vault_expire
ON SCHEDULE EVERY 15 MINUTE
DO DELETE FROM vault WHERE expires_at IS NOT NULL AND expires_at < UNIX_TIMESTAMP()
`

export class MysqlStore implements Store {
  private readonly pool: Pool

  constructor(config: MysqlConfig) {
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

  /** Creates the table and the expiry event. Idempotent, and safe to run on
   *  every start — which is where it is called from, so a fresh database needs
   *  no manual step. */
  async migrate(): Promise<void> {
    await this.pool.query(SCHEMA)
    try {
      await this.pool.query(CLEANUP_EVENT)
      await this.pool.query('SET GLOBAL event_scheduler = ON')
    } catch (err) {
      // Creating events or setting a global needs privileges the application
      // user may not have. Expiry is then a job for the operator rather than a
      // reason to refuse to start; see docs/runbook.md.
      console.warn('could not install the expiry event:', (err as Error).message)
    }
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
