// The item model: what each entry type holds, how folders nest, and what
// search looks at. Shared by every client, so the web app and the extension
// agree on what a "card" is.
//
// Types are described here, not in the crypto package: the sealed blob is one
// JSON document either way, and adding a field to a type must not touch the
// cryptography. Entries are stored as packages/crypto's EntryContent; this
// file only reads the parts it needs, structurally.

export type EntryType = 'login' | 'note' | 'card' | 'identity' | 'bankAccount' | 'sshKey' | 'wifi'

/** How a field is shown and edited. */
export type FieldKind =
  | 'text'       // plain, copyable
  | 'secret'     // masked until revealed; copy clears the clipboard
  | 'multiline'  // a block, e.g. an address
  | 'secretBlock'// a masked block, e.g. a private key
  | 'url'
  | 'email'
  | 'phone'
  | 'totp'       // a base32 TOTP key, shown as a live code
  | 'expiry'     // MM/YY
  | 'select'

export interface FieldSpec {
  key: string
  label: string
  kind: FieldKind
  /** Where the value lives: one of the entry's top-level fields, or its
   *  type-specific `fields` map. Top-level is kept for login and Wi-Fi so
   *  entries saved before types had their own fields still read correctly. */
  at: 'username' | 'password' | 'url' | 'totpSecret' | 'fields'
  placeholder?: string
  options?: readonly (readonly [string, string])[]
  /** Offered by the password generator. */
  generate?: boolean
}

export interface TypeSpec {
  type: EntryType
  label: string
  plural: string
  fields: readonly FieldSpec[]
  /** The field whose value best identifies an entry in a list. */
  subtitle?: string
}

const f = (key: string, label: string, kind: FieldKind, extra: Partial<FieldSpec> = {}): FieldSpec =>
  ({ key, label, kind, at: 'fields', ...extra })

export const TYPE_SPECS: readonly TypeSpec[] = [
  {
    type: 'login', label: 'Login', plural: 'Logins', subtitle: 'username',
    fields: [
      { key: 'username', label: 'Username or email', kind: 'text', at: 'username' },
      { key: 'password', label: 'Password', kind: 'secret', at: 'password', generate: true },
      { key: 'url', label: 'Website', kind: 'url', at: 'url', placeholder: 'https://' },
      { key: 'totpSecret', label: 'One-time code (TOTP key)', kind: 'totp', at: 'totpSecret', placeholder: 'Base32 key from the site' },
    ],
  },
  { type: 'note', label: 'Secure note', plural: 'Secure notes', fields: [] },
  {
    type: 'card', label: 'Card', plural: 'Cards', subtitle: 'cardholder',
    fields: [
      f('cardholder', 'Name on card', 'text'),
      f('number', 'Card number', 'secret', { placeholder: '1234 5678 9012 3456' }),
      f('expiry', 'Expiry', 'expiry', { placeholder: 'MM/YY' }),
      f('cvv', 'Security code', 'secret', { placeholder: 'CVV' }),
      f('pin', 'PIN', 'secret'),
    ],
  },
  {
    type: 'identity', label: 'Identity', plural: 'Identities', subtitle: 'fullName',
    fields: [
      f('fullName', 'Full name', 'text'),
      f('email', 'Email', 'email'),
      f('phone', 'Phone', 'phone'),
      f('dateOfBirth', 'Date of birth', 'text', { placeholder: 'DD/MM/YYYY' }),
      f('address', 'Address', 'multiline'),
      f('nationalId', 'ID number (Aadhaar, PAN, passport…)', 'secret'),
      f('company', 'Company', 'text'),
    ],
  },
  {
    type: 'bankAccount', label: 'Bank account', plural: 'Bank accounts', subtitle: 'bankName',
    fields: [
      f('bankName', 'Bank', 'text'),
      f('accountHolder', 'Account holder', 'text'),
      f('accountNumber', 'Account number', 'secret'),
      f('routing', 'IFSC / routing / sort code', 'text'),
      f('iban', 'IBAN', 'text'),
      f('accountType', 'Account type', 'select', { options: [['savings', 'Savings'], ['current', 'Current'], ['checking', 'Checking'], ['other', 'Other']] }),
      f('pin', 'PIN', 'secret'),
    ],
  },
  {
    type: 'sshKey', label: 'SSH key', plural: 'SSH keys', subtitle: 'host',
    fields: [
      f('host', 'Host', 'text', { placeholder: 'user@server.example.com' }),
      f('publicKey', 'Public key', 'multiline', { placeholder: 'ssh-ed25519 AAAA…' }),
      f('privateKey', 'Private key', 'secretBlock', { placeholder: '-----BEGIN OPENSSH PRIVATE KEY-----' }),
      f('passphrase', 'Passphrase', 'secret'),
    ],
  },
  {
    type: 'wifi', label: 'Wi-Fi', plural: 'Wi-Fi', subtitle: 'username',
    fields: [
      { key: 'username', label: 'Network name (SSID)', kind: 'text', at: 'username' },
      { key: 'password', label: 'Password', kind: 'secret', at: 'password', generate: true },
      f('security', 'Security', 'select', { options: [['wpa2', 'WPA2'], ['wpa3', 'WPA3'], ['wpa', 'WPA'], ['wep', 'WEP'], ['open', 'Open']] }),
    ],
  },
]

export const typeSpec = (type: string): TypeSpec => TYPE_SPECS.find((t) => t.type === type) ?? TYPE_SPECS[0]!

/** The parts of an entry the model reads. Structurally a subset of
 *  packages/crypto's EntryContent. */
export interface EntryLike {
  name: string
  type: string
  username?: string | undefined
  password?: string | undefined
  url?: string | undefined
  totpSecret?: string | undefined
  notes?: string | undefined
  tags?: string[]
  fields?: Record<string, string> | undefined
  customFields?: { label: string; value: string; hidden: boolean }[]
}

export function readField(entry: EntryLike, spec: FieldSpec): string {
  if (spec.at === 'fields') return entry.fields?.[spec.key] ?? ''
  return entry[spec.at] ?? ''
}

/** Returns a copy of the entry with one field set, in the right place. */
export function writeField<T extends EntryLike>(entry: T, spec: FieldSpec, value: string): T {
  if (spec.at === 'fields') return { ...entry, fields: { ...(entry.fields ?? {}), [spec.key]: value } }
  return { ...entry, [spec.at]: value }
}

/** One line under the entry's name in a list. Never a secret. */
export function subtitle(entry: EntryLike): string {
  const spec = typeSpec(entry.type)
  if (entry.type === 'card') {
    const n = (entry.fields?.['number'] ?? '').replace(/\D/g, '')
    if (n.length >= 4) return `${cardBrand(n) ?? 'Card'} •••• ${n.slice(-4)}`
  }
  const field = spec.fields.find((x) => x.key === spec.subtitle)
  const value = field && field.kind !== 'secret' ? readField(entry, field) : ''
  return value || hostOf(entry.url) || spec.label
}

/** Text search runs in the browser over what was decrypted there. Secrets
 *  are left out, so typing part of a password does not find it on screen. */
export function matches(entry: EntryLike, query: string, folderPath = ''): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const spec = typeSpec(entry.type)
  const visible = spec.fields.filter((x) => x.kind !== 'secret' && x.kind !== 'secretBlock' && x.kind !== 'totp').map((x) => readField(entry, x))
  const haystack = [entry.name, entry.url, folderPath, ...(entry.tags ?? []), ...visible,
    ...(entry.customFields ?? []).filter((c) => !c.hidden).flatMap((c) => [c.label, c.value])]
  return haystack.some((s) => s?.toLowerCase().includes(q))
}

export function hostOf(url: string | undefined): string {
  if (!url) return ''
  try { return new URL(url.includes('://') ? url : `https://${url}`).hostname } catch { return url }
}

/** Recognises a card network from its number's prefix, for display only. */
export function cardBrand(number: string): string | null {
  const n = number.replace(/\D/g, '')
  if (/^4/.test(n)) return 'Visa'
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(n)) return 'Mastercard'
  if (/^3[47]/.test(n)) return 'Amex'
  if (/^(60|65|81|82|508)/.test(n)) return 'RuPay'
  if (/^6(011|5)/.test(n)) return 'Discover'
  if (/^35(2[89]|[3-8])/.test(n)) return 'JCB'
  if (/^3(0[0-5]|[68])/.test(n)) return 'Diners'
  return null
}

/** Groups a card number in fours (Amex 4-6-5), for display. */
export function formatCardNumber(number: string): string {
  const n = number.replace(/\D/g, '')
  if (/^3[47]/.test(n)) return [n.slice(0, 4), n.slice(4, 10), n.slice(10, 15)].filter(Boolean).join(' ')
  return n.replace(/(.{4})/g, '$1 ').trim()
}

// ── Folders ─────────────────────────────────────────────────────────────────

export const MAX_FOLDER_DEPTH = 4

export interface FolderLike { id: string; name: string; parentId?: string | undefined }

export interface FolderNode<F extends FolderLike = FolderLike> {
  folder: F
  depth: number
  children: FolderNode<F>[]
}

/** Builds the tree, sorted by name at every level. A folder whose parent is
 *  missing — deleted elsewhere, or never synced — becomes a root rather than
 *  disappearing; a cycle is broken the same way. */
export function folderTree<F extends FolderLike>(folders: readonly F[]): FolderNode<F>[] {
  const byId = new Map(folders.map((x) => [x.id, x]))
  const children = new Map<string | undefined, F[]>()
  for (const x of folders) {
    let parent = x.parentId && byId.has(x.parentId) ? x.parentId : undefined
    // Walk up; if we come back to x, its chain is a cycle — make it a root.
    for (let p = parent, seen = 0; p && seen <= folders.length; p = byId.get(p)?.parentId, seen++) {
      if (p === x.id) { parent = undefined; break }
    }
    children.set(parent, [...(children.get(parent) ?? []), x])
  }
  const build = (parent: string | undefined, depth: number): FolderNode<F>[] =>
    (children.get(parent) ?? [])
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((folder) => ({ folder, depth, children: build(folder.id, depth + 1) }))
  return build(undefined, 0)
}

/** The tree flattened in display order, each folder once. */
export function flattenTree<F extends FolderLike>(nodes: FolderNode<F>[]): FolderNode<F>[] {
  return nodes.flatMap((n) => [n, ...flattenTree(n.children)])
}

/** "Work / Servers / AWS" */
export function folderPath(folders: readonly FolderLike[], id: string | undefined): string {
  const byId = new Map(folders.map((x) => [x.id, x]))
  const parts: string[] = []
  for (let cur = id ? byId.get(id) : undefined, n = 0; cur && n <= folders.length; cur = cur.parentId ? byId.get(cur.parentId) : undefined, n++) {
    parts.unshift(cur.name)
  }
  return parts.join(' / ')
}

/** The folder and every folder beneath it, for filtering a folder's view. */
export function descendants(folders: readonly FolderLike[], id: string): Set<string> {
  const out = new Set([id])
  let grew = true
  while (grew) {
    grew = false
    for (const x of folders) if (x.parentId && out.has(x.parentId) && !out.has(x.id)) { out.add(x.id); grew = true }
  }
  return out
}

export function depthOf(folders: readonly FolderLike[], id: string | undefined): number {
  return id ? folderPath(folders, id).split(' / ').length : 0
}
