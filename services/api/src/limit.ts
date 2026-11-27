// Bounded fan-out. Reading one row per account with Promise.all sends every
// query at once; the MySQL pool holds four connections and a short queue, so
// a server with a few dozen accounts had its admin overview and users list
// refused with "queue limit reached" (a 500). Work through a list a few at a
// time instead: the pool stays busy, never flooded.

/** The default number of store calls one request keeps in flight. */
export const FAN_OUT = 4

/** Like Promise.all(items.map(fn)), in order, at most `limit` at a time. */
export async function mapLimit<T, R>(items: readonly T[], fn: (item: T, index: number) => Promise<R>, limit = FAN_OUT): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!, i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker))
  return out
}
