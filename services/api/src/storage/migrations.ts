// Schema versions, for every SQL driver.
//
// The vault is one table of (pk, sk, JSON document, expiry), and the server
// cannot read the documents, so schema changes are rare: most changes to what
// is stored happen inside the JSON. When one is needed, it is appended here
// as the next version, for each driver, and runs once on start.
//
// Rules: never edit a released version; never remove one; every version must
// be safe to run against a database that a previous release created by hand
// (hence IF NOT EXISTS in version 1, which adopts the reference instance's
// existing table). test/storage.test.ts runs every driver from empty.

export type Driver = 'mysql' | 'postgres' | 'sqlite'

export interface Migration {
  version: number
  description: string
  sql: Record<Driver, string[]>
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: 'the vault table and its expiry index',
    sql: {
      mysql: [
        `CREATE TABLE IF NOT EXISTS vault (
           pk VARCHAR(255) NOT NULL, sk VARCHAR(255) NOT NULL, data JSON NOT NULL, expires_at BIGINT NULL,
           PRIMARY KEY (pk, sk), KEY idx_expires (expires_at)
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      ],
      // COLLATE "C": byte order, so sort-key ordering and prefixes behave the
      // same as in the other drivers whatever the server's locale.
      postgres: [
        `CREATE TABLE IF NOT EXISTS vault (
           pk TEXT COLLATE "C" NOT NULL, sk TEXT COLLATE "C" NOT NULL, data JSONB NOT NULL, expires_at BIGINT NULL,
           PRIMARY KEY (pk, sk))`,
        'CREATE INDEX IF NOT EXISTS idx_vault_expires ON vault (expires_at) WHERE expires_at IS NOT NULL',
      ],
      sqlite: [
        `CREATE TABLE IF NOT EXISTS vault (
           pk TEXT NOT NULL, sk TEXT NOT NULL, data TEXT NOT NULL, expires_at INTEGER NULL,
           PRIMARY KEY (pk, sk)) WITHOUT ROWID`,
        'CREATE INDEX IF NOT EXISTS idx_vault_expires ON vault (expires_at) WHERE expires_at IS NOT NULL',
      ],
    },
  },
  {
    version: 2,
    description: 'case-sensitive keys in MySQL, as in every other store',
    sql: {
      // The reference instance's table was created with the server default
      // collation, utf8mb4_0900_ai_ci, which is case-insensitive: "ENTRY#abc"
      // and "ENTRY#ABC" were one key, and a prefix matched either case. Binary
      // collation makes keys exact. Going from insensitive to exact cannot
      // create a duplicate, so this cannot fail on existing data.
      mysql: ['ALTER TABLE vault MODIFY pk VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, MODIFY sk VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL'],
      // Already exact: PostgreSQL's columns are COLLATE "C", SQLite compares
      // bytes. Nothing to change.
      postgres: ['SELECT 1'],
      sqlite: ['SELECT 1'],
    },
  },
]

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version

/** The bookkeeping table, per driver. */
export const META_TABLE: Record<Driver, string> = {
  mysql: 'CREATE TABLE IF NOT EXISTS vault_meta (k VARCHAR(64) PRIMARY KEY, v VARCHAR(255) NOT NULL) ENGINE=InnoDB',
  postgres: 'CREATE TABLE IF NOT EXISTS vault_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)',
  sqlite: 'CREATE TABLE IF NOT EXISTS vault_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)',
}

/** Refuses to run against a database a newer release has already upgraded:
 *  an old server writing to a newer schema is how data gets damaged quietly. */
export function pending(current: number, target = LATEST_VERSION): Migration[] {
  if (current > LATEST_VERSION) {
    throw new Error(`the database is at schema version ${current}, newer than this server understands (${LATEST_VERSION}); install the newer release`)
  }
  return MIGRATIONS.filter((m) => m.version > current && m.version <= target)
}
