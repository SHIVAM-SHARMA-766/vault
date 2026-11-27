// Related items: an item lists the ids of others it goes with; the link reads
// both ways. Worked out from the decrypted vault, in the browser.

export interface Relatable { id: string; related?: string[] | undefined; archived?: boolean | undefined }

/** How many items one may list. */
export const RELATED_MAX = 20

/** The items related to `id`: those it lists, then those that list it, each
 *  once, skipping itself, missing ids and (unless asked) archived items. */
export function relatedItems<T extends Relatable>(id: string, all: readonly T[], { archived = false } = {}): T[] {
  const byId = new Map(all.map((e) => [e.id, e]))
  const self = byId.get(id)
  const out: T[] = []
  const seen = new Set<string>([id])
  const add = (e: T | undefined) => {
    if (!e || seen.has(e.id) || (e.archived && !archived)) return
    seen.add(e.id)
    out.push(e)
  }
  for (const other of self?.related ?? []) add(byId.get(other))
  for (const e of all) if (e.related?.includes(id)) add(e)
  return out
}

/** A clean list to save: strings, no repeats, not itself, at most RELATED_MAX. */
export function cleanRelated(id: string | undefined, related: readonly unknown[] | undefined): string[] {
  const out: string[] = []
  for (const r of related ?? []) {
    if (typeof r !== 'string' || !r || r === id || out.includes(r)) continue
    out.push(r)
    if (out.length >= RELATED_MAX) break
  }
  return out
}
