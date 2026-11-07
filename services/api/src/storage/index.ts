// Opens the store the configuration names. Drivers load lazily, so an install
// carries only the database client it uses at run time — and the reference
// release, which bundles the API into one file, never loads the native SQLite
// module it does not need.

import type { Config } from '../config.js'
import type { ManagedStore } from '../store.js'

export async function openStore(config: Config): Promise<ManagedStore> {
  const db = config.db
  switch (db.driver) {
    case 'mysql': {
      const { MysqlStore } = await import('../store-mysql.js')
      return new MysqlStore({ host: db.host, user: db.user, password: db.password, database: db.database, port: db.port })
    }
    case 'postgres': {
      const { PostgresStore } = await import('./postgres.js')
      return PostgresStore.open({ host: db.host, user: db.user, password: db.password, database: db.database, port: db.port, ssl: db.ssl })
    }
    case 'sqlite': {
      const { SqliteStore } = await import('./sqlite.js')
      return SqliteStore.open(db.path)
    }
  }
}
