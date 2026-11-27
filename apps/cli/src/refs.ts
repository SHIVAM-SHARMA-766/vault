// Secret references: vault://<item>/<field>, as written in a .env template
// or a config file, and resolved against the decrypted vault on this machine.
//
//   vault://GitHub/password            a login's password
//   vault://Prod database/fields.host  a type's own field (packages/core names)
//   vault://Stripe/API key             a custom field, by its label
//   vault://GitHub/totp                the current one-time code
//
// An item is matched by name (case-insensitive); a name that matches more
// than one item, or none, is an error rather than a guess. Item ids work too.

export interface Item {
  id: string
  name: string
  username?: string
  password?: string
  url?: string
  notes?: string
  totpSecret?: string
  customFields?: { label: string; value: string }[]
  fields?: Record<string, string>
}

export interface Ref { item: string; field: string }

/** A reference inside a longer value: no spaces (write %20), and the field
 *  ends at anything but letters, digits and . _ % -. A value that is a
 *  reference and nothing else may have spaces in it. */
const REF = /vault:\/\/[^\s"'/@:]+\/[A-Za-z0-9_.%-]+/g

/** Splits vault://item/field, decoding %XX (for names with a slash). */
export function parseRef(text: string): Ref {
  const m = /^vault:\/\/([^/]+)\/(.+)$/.exec(text.trim())
  if (!m) throw new Error(`Not a secret reference: ${text}. Write vault://<item>/<field>.`)
  return { item: decodeURIComponent(m[1]!), field: decodeURIComponent(m[2]!) }
}

export function findItem(items: Item[], name: string): Item {
  const byId = items.find((i) => i.id === name)
  if (byId) return byId
  const found = items.filter((i) => i.name.toLowerCase() === name.toLowerCase())
  if (found.length === 0) throw new Error(`No item named "${name}".`)
  if (found.length > 1) throw new Error(`${found.length} items are named "${name}". Rename one, or use its id.`)
  return found[0]!
}

/** The value of one field; `totp` is computed by the caller (it needs the clock). */
export function fieldOf(item: Item, field: string): string {
  const f = field.toLowerCase()
  const plain: Record<string, string | undefined> = { password: item.password, username: item.username, url: item.url, notes: item.notes, name: item.name }
  if (f in plain) {
    const v = plain[f]
    if (v === undefined || v === '') throw new Error(`"${item.name}" has no ${f}.`)
    return v
  }
  if (f.startsWith('fields.')) {
    const key = field.slice('fields.'.length)
    const v = item.fields?.[key]
    if (v === undefined) throw new Error(`"${item.name}" has no field "${key}".`)
    return v
  }
  const custom = (item.customFields ?? []).filter((c) => c.label.toLowerCase() === f)
  if (custom.length === 1) return custom[0]!.value
  if (custom.length > 1) throw new Error(`"${item.name}" has ${custom.length} fields labelled "${field}".`)
  throw new Error(`"${item.name}" has no field "${field}". Use password, username, url, notes, totp, fields.<name> or a custom field's label.`)
}

/** Every vault:// reference in a piece of text. */
export function refsIn(text: string): string[] {
  if (/^vault:\/\/[^/]+\/.+$/.test(text.trim())) return [text.trim()]
  return [...text.matchAll(REF)].map((m) => m[0])
}

/** A .env template: KEY=value lines, values may be vault:// references
 *  (whole or inside the value). Comments and blank lines are kept out. */
export function parseEnvTemplate(text: string): [string, string][] {
  const out: [string, string][] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) throw new Error(`Not KEY=value: ${line}`)
    let v = m[2]!
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out.push([m[1]!, v])
  }
  return out
}

/** Replaces every reference in a value, using `resolve` for each. */
export async function substitute(value: string, resolve: (ref: string) => Promise<string>): Promise<string> {
  if (/^vault:\/\/[^/]+\/.+$/.test(value.trim())) return resolve(value.trim())
  let out = ''
  let last = 0
  for (const m of value.matchAll(REF)) {
    out += value.slice(last, m.index) + await resolve(m[0])
    last = m.index! + m[0].length
  }
  return out + value.slice(last)
}
