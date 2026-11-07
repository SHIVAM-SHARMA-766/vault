// PostgreSQL, behind the same interface as every other store. For the
// business install profile (phase 2): several app instances can share it, and
// migrations take an advisory lock so two starting at once do not race.

import { AlreadyExists, type Item, type Store } from '../store.js'
import { META_TABLE, pending } from './migrations.js'

export interface PostgresConfig {
  host: string
  port: number
  user: string
  password: string
  database: string
  /** "require" for a managed database across a network. */
  ssl?: boolean
}

type Pool = import('pg').Pool

const fromRow = (row: { pk: string; sk: string; data: Record<string, unknown> }): Item => ({ pk: row.pk, sk: row.sk, ...row.data })
const toJson = ({ pk: _pk, sk: _sk, ...rest }: Item): string => JSON.stringify(rest)
const likePrefix = (prefix: string) => `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
/** Any constant; it names this application's migration lock. */
const MIGRATION_LOCK = 7_291_843

export class PostgresStore implements Store {
  private pool!: Pool
  private constructor() {}

  static async open(config: PostgresConfig): Promise<PostgresStore> {
    const { default: pg } = await import('pg')
    const store = new PostgresStore()
    store.pool = new pg.Pool({
      host: config.host, port: config.port, user: config.user, password: config.password, database: config.database,
      max: 8, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000,
      ...(config.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
    })
    return store
  }

  async migrate(): Promise<number> {
    const client = await this.pool.connect()
    try {
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK])
      await client.query(META_TABLE.postgres)
      const row = (await client.query<{ v: string }>("SELECT v FROM vault_meta WHERE k = 'schema_version'")).rows[0]
      let version = Number(row?.v ?? 0)
      for (const m of pending(version)) {
        await client.query('BEGIN')
        try {
          for (const sql of m.sql.postgres) await client.query(sql)
          await client.query(
            "INSERT INTO vault_meta (k, v) VALUES ('schema_version', $1) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v",
            [String(m.version)],
          )
          await client.query('COMMIT')
          version = m.version
        } catch (err) {
          await client.query('ROLLBACK')
          throw err
        }
      }
      return version
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {})
      client.release()
    }
  }

  async get(pk: string, sk: string): Promise<Item | null> {
    const { rows } = await this.pool.query('SELECT pk, sk, data FROM vault WHERE pk = $1 AND sk = $2', [pk, sk])
    return rows[0] ? fromRow(rows[0]) : null
  }

  async put(item: Item, opts: { mustNotExist?: boolean } = {}): Promise<void> {
    const expiresAt = typeof item['expiresAt'] === 'number' ? item['expiresAt'] : null
    if (opts.mustNotExist) {
      const res = await this.pool.query(
        'INSERT INTO vault (pk, sk, data, expires_at) VALUES ($1, $2, $3::jsonb, $4) ON CONFLICT (pk, sk) DO NOTHING',
        [item.pk, item.sk, toJson(item), expiresAt],
      )
      if (res.rowCount === 0) throw new AlreadyExists()
      return
    }
    await this.pool.query(
      `INSERT INTO vault (pk, sk, data, expires_at) VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (pk, sk) DO UPDATE SET data = EXCLUDED.data, expires_at = EXCLUDED.expires_at`,
      [item.pk, item.sk, toJson(item), expiresAt],
    )
  }

  async delete(pk: string, sk: string): Promise<void> {
    await this.pool.query('DELETE FROM vault WHERE pk = $1 AND sk = $2', [pk, sk])
  }

  async query(pk: string, skPrefix?: string): Promise<Item[]> {
    const { rows } = skPrefix
      ? await this.pool.query("SELECT pk, sk, data FROM vault WHERE pk = $1 AND sk LIKE $2 ESCAPE '\\' ORDER BY sk", [pk, likePrefix(skPrefix)])
      : await this.pool.query('SELECT pk, sk, data FROM vault WHERE pk = $1 ORDER BY sk', [pk])
    return rows.map(fromRow)
  }

  /** One statement: insert or add one, and return the new value. */
  async increment(pk: string, sk: string, expiresAt: number): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `INSERT INTO vault (pk, sk, data, expires_at) VALUES ($1, $2, '{"count": 1}'::jsonb, $3)
       ON CONFLICT (pk, sk) DO UPDATE SET data = jsonb_set(vault.data, '{count}', to_jsonb(COALESCE((vault.data->>'count')::int, 0) + 1))
       RETURNING data->>'count' AS count`,
      [pk, sk, expiresAt],
    )
    return Number(rows[0]?.count ?? 1)
  }

  async sweepExpired(now = Math.floor(Date.now() / 1000)): Promise<number> {
    const res = await this.pool.query('DELETE FROM vault WHERE expires_at IS NOT NULL AND expires_at < $1', [now])
    return res.rowCount ?? 0
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
