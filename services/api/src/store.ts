// Storage, behind an interface.
//
// The DynamoDB implementation is the one that runs; the in-memory one in the
// tests is what makes the routes testable without an AWS account. Keeping the
// surface this narrow is also what makes the IAM policy narrow — every
// operation here appears in the role, and Scan appears in neither.

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

/** Raised by `put` when `mustNotExist` was requested and the item was there. */
export class AlreadyExists extends Error {
  constructor() {
    super('item already exists')
    this.name = 'AlreadyExists'
  }
}
