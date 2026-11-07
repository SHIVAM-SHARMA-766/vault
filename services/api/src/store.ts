// Storage, behind an interface.
//
// Three SQL implementations run it — MySQL (the reference instance),
// PostgreSQL (business installs) and SQLite (personal installs), in storage/
// — and an in-memory one makes the routes testable with no database at all.
// test/store-contract.test.ts holds every one of them to the same behaviour.
// No route reaches past this interface (a test checks), which is what lets a
// customer choose their database.

export interface Item {
  pk: string
  sk: string
  [key: string]: unknown
}

export interface Store {
  get(pk: string, sk: string): Promise<Item | null>
  /** `mustNotExist` maps to a condition expression, so a duplicate
   *  registration fails in the database rather than in a read-then-write race. */
  put(item: Item, opts?: { mustNotExist?: boolean }): Promise<void>
  delete(pk: string, sk: string): Promise<void>
  query(pk: string, skPrefix?: string): Promise<Item[]>
  /** Atomic counter with an expiry, for rate-limit windows. Returns the value
   *  after incrementing. */
  increment(pk: string, sk: string, expiresAt: number): Promise<number>
}

/** What the server needs from a store beyond the routes' five methods. */
export interface ManagedStore extends Store {
  /** Brings the schema up to date; returns the schema version. Idempotent. */
  migrate(target?: number): Promise<number>
  /** Removes rows whose expiry has passed; returns how many. */
  sweepExpired(now?: number): Promise<number>
  close(): Promise<void>
  /** Every row in the table, for backups only — no route can reach this,
   *  because routes are given the five-method Store. */
  scan(): Promise<Item[]>
}

/** Raised by `put` when `mustNotExist` was requested and the item was there. */
export class AlreadyExists extends Error {
  constructor() {
    super('item already exists')
    this.name = 'AlreadyExists'
  }
}
