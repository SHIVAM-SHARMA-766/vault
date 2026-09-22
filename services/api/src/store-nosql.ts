// Oracle NoSQL, behind the same five-method interface the in-memory store
// implements. Swapping providers is this file and nothing else, which is how
// the move off the previous platform cost one afternoon rather than a rewrite.
//
// The instance authenticates as itself through a dynamic group that matches its
// OCID, so no credential is read from disk or from the environment.

import {
  NoSQLClient,
  type PreparedStatement,
  type QueryContinuationKey,
  Region,
  ServiceType,
} from 'oracle-nosqldb'

import { AlreadyExists, type Item, type Store } from './store.js'

/** Rows carry `pk`, `sk`, and everything else inside a JSON column. The server
 *  cannot interpret what is in `data`, so giving it a schema would be a schema
 *  it could not enforce. */
interface Row {
  pk: string
  sk: string
  data: Record<string, unknown>
}

const toRow = (item: Item): Row => {
  const { pk, sk, ...rest } = item
  return { pk, sk, data: rest }
}

const fromRow = (row: Row | null): Item | null =>
  row ? ({ pk: row.pk, sk: row.sk, ...(row.data ?? {}) } as Item) : null

/** Seconds until an item should disappear, or undefined for one that should
 *  not. Sessions and activity records carry `expiresAt`; nothing else does, so
 *  nothing else is ever expired. */
function ttlFor(item: Item, now: number): number | undefined {
  const expiresAt = item['expiresAt']
  if (typeof expiresAt !== 'number') return undefined
  const seconds = expiresAt - Math.floor(now / 1000)
  return seconds > 0 ? seconds : 1
}

export class NoSqlStore implements Store {
  private readonly client: NoSQLClient
  private readonly table: string
  private readonly now: () => number

  // Bound variables travel on a prepared statement rather than in the query
  // text, which is also what keeps a sort-key prefix from being able to change
  // the shape of the query. There are only two statements, so both are
  // prepared once and reused for the life of the process.
  private prepared = new Map<string, Promise<PreparedStatement>>()

  constructor(table: string, region: string, now: () => number = Date.now) {
    this.table = table
    this.now = now
    this.client = new NoSQLClient({
      region: Region.fromRegionId(region) ?? region,
      auth: { iam: { useInstancePrincipal: true } },
      serviceType: ServiceType.CLOUD,

      // Without these, a storage outage turns every request into one that
      // hangs rather than one that fails — which on a one-core host means the
      // process stops answering anything at all. Found by starting the bundle
      // with no NoSQL reachable and watching a request sit for ten seconds.
      timeout: 5000,
      ddlTimeout: 10000,
      retry: { maxRetries: 2 },
    })
  }

  async get(pk: string, sk: string): Promise<Item | null> {
    const result = await this.client.get<Row>(this.table, { pk, sk })
    return fromRow(result.row ?? null)
  }

  async put(item: Item, opts: { mustNotExist?: boolean } = {}): Promise<void> {
    const ttl = ttlFor(item, this.now())
    const options = {
      ...(opts.mustNotExist ? { ifAbsent: true } : {}),
      ...(ttl === undefined ? {} : { ttl: { days: Math.max(1, Math.ceil(ttl / 86400)) } }),
    }
    const result = await this.client.put(this.table, toRow(item), options)

    // ifAbsent turns a duplicate into a refused write rather than an overwrite,
    // so two concurrent registrations for one address lose in the database
    // instead of both creating a profile.
    if (opts.mustNotExist && result.success === false) throw new AlreadyExists()
  }

  async delete(pk: string, sk: string): Promise<void> {
    await this.client.delete(this.table, { pk, sk })
  }

  /** Everything in one partition, optionally narrowed by a sort-key prefix.
   *  Paged until exhausted: at the provisioned rate a large vault throttles
   *  rather than bills, which is the intended behaviour. */
  private prepare(statement: string): Promise<PreparedStatement> {
    let pending = this.prepared.get(statement)
    if (!pending) {
      pending = this.client.prepare(statement)
      this.prepared.set(statement, pending)
    }
    return pending
  }

  async query(pk: string, skPrefix?: string): Promise<Item[]> {
    const statement = skPrefix
      ? `DECLARE $pk STRING; $sk STRING; SELECT * FROM ${this.table} t WHERE t.pk = $pk AND starts_with(t.sk, $sk)`
      : `DECLARE $pk STRING; SELECT * FROM ${this.table} t WHERE t.pk = $pk`

    // A prepared statement carries its bindings, so it cannot be shared between
    // concurrent queries. Copying is cheap; the preparation is what was worth
    // caching.
    const stmt = (await this.prepare(statement)).copyStatement()
    stmt.set('$pk', pk)
    if (skPrefix) stmt.set('$sk', skPrefix)

    const items: Item[] = []
    let continuationKey: QueryContinuationKey | null = null
    do {
      const result: { rows?: Row[]; continuationKey?: QueryContinuationKey | null } =
        await this.client.query<Row>(stmt, continuationKey ? { continuationKey } : {})
      for (const row of result.rows ?? []) {
        const item = fromRow(row)
        if (item) items.push(item)
      }
      continuationKey = result.continuationKey ?? null
    } while (continuationKey)

    return items
  }

  /** A rate-limit window. Read-modify-write under a version check rather than a
   *  native counter: NoSQL has no atomic increment, and the compare-and-set
   *  retry costs less than the request it is limiting. */
  async increment(pk: string, sk: string, expiresAt: number): Promise<number> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const existing = await this.client.get<Row>(this.table, { pk, sk })
      const current = Number((existing.row?.data as { count?: number } | undefined)?.count ?? 0)
      const next = current + 1
      const ttlSeconds = Math.max(1, expiresAt - Math.floor(this.now() / 1000))

      const row: Row = { pk, sk, data: { count: next, expiresAt } }
      const ttl = { days: Math.max(1, Math.ceil(ttlSeconds / 86400)) }
      // Either the row is there and must not have moved since the read, or it
      // is not there and must still be absent when the write lands. Both forms
      // turn a lost race into a refused write rather than a lost count.
      const result = await (existing.version
        ? this.client.put(this.table, row, { ttl, matchVersion: existing.version })
        : this.client.put(this.table, row, { ttl, ifAbsent: true }))
      if (result.success !== false) return next
      // Lost the race; another request incremented first. Read again.
    }
    // Five failures means sustained contention, which is itself the condition
    // the limiter exists to catch. Refusing is the safe answer.
    throw new Error('rate limit counter contended')
  }
}

