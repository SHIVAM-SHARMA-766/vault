// An in-memory Store with the semantics the routes depend on: point lookups,
// conditional writes, prefix queries on the sort key, and atomic counters.
//
// Used by the tests and by scripts/dev-stack.mjs, so the whole product runs
// locally with no database. Never used in production; server.ts wires
// MysqlStore.

import { AlreadyExists, type Item, type Store } from './store.js'

export class MemoryStore implements Store {
  private readonly items = new Map<string, Item>()

  private static key(pk: string, sk: string): string {
    return `${pk}\u0000${sk}`
  }

  async get(pk: string, sk: string): Promise<Item | null> {
    const found = this.items.get(MemoryStore.key(pk, sk))
    return found ? structuredClone(found) : null
  }

  async put(item: Item, opts: { mustNotExist?: boolean } = {}): Promise<void> {
    const key = MemoryStore.key(item.pk, item.sk)
    if (opts.mustNotExist && this.items.has(key)) throw new AlreadyExists()
    this.items.set(key, structuredClone(item))
  }

  async delete(pk: string, sk: string): Promise<void> {
    this.items.delete(MemoryStore.key(pk, sk))
  }

  async query(pk: string, skPrefix?: string): Promise<Item[]> {
    return [...this.items.values()]
      .filter((i) => i.pk === pk && (!skPrefix || i.sk.startsWith(skPrefix)))
      .sort((a, b) => a.sk.localeCompare(b.sk))
      .map((i) => structuredClone(i))
  }

  async increment(pk: string, sk: string, expiresAt: number): Promise<number> {
    const key = MemoryStore.key(pk, sk)
    const existing = this.items.get(key)
    const count = Number(existing?.['count'] ?? 0) + 1
    this.items.set(key, { pk, sk, count, expiresAt })
    return count
  }

  /** Tests only: what the table actually holds, for asserting that something
   *  was or was not written. */
  dump(): Item[] {
    return [...this.items.values()].map((i) => structuredClone(i))
  }
}
