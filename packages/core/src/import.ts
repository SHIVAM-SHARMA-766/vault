// Reading other password managers' exports.
//
// Runs in the browser, on a file the user picked: nothing is uploaded until it
// has been turned into entries and encrypted. Each format becomes the same
// ImportedItem shape; the client then seals and saves them.
//
// Formats are recognised from their headers (CSV) or structure (JSON), not
// from the file name. Anything unrecognised but CSV-shaped falls back to
// guessing columns by name.

import type { EntryType } from './items.js'

export interface ImportedItem {
  name: string
  type: EntryType
  username?: string | undefined
  password?: string | undefined
  url?: string | undefined
  totpSecret?: string | undefined
  notes?: string | undefined
  fields?: Record<string, string> | undefined
  customFields: { label: string; value: string; hidden: boolean }[]
  tags: string[]
  favorite: boolean
  /** Folder path, levels separated by " / ". Empty for none. */
  folder: string
}

export interface ImportResult {
  /** Human-readable source, e.g. "Bitwarden (JSON)". */
  format: string
  items: ImportedItem[]
  /** Every folder path the items use, parents before children. */
  folders: string[]
  warnings: string[]
}

export class ImportError extends Error {
  constructor(message: string) { super(message); this.name = 'ImportError' }
}

// ── CSV ─────────────────────────────────────────────────────────────────────

/** RFC 4180: quoted fields, doubled quotes, CRLF or LF, a leading BOM. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') quoted = false
      else field += c
    } else if (c === '"' && field === '') {
      quoted = true
    } else if (c === ',') {
      row.push(field); field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some((v) => v !== '')) rows.push(row)
      row = []
    } else {
      field += c
    }
  }
  row.push(field)
  if (row.some((v) => v !== '')) rows.push(row)
  return rows
}

type Row = Record<string, string>

function records(rows: string[][]): { headers: string[]; data: Row[] } {
  const [head, ...rest] = rows
  const headers = (head ?? []).map((h) => h.trim())
  const lower = headers.map((h) => h.toLowerCase())
  return {
    headers,
    data: rest.map((r) => Object.fromEntries(lower.map((h, i) => [h, (r[i] ?? '').trim()]))),
  }
}

const has = (headers: string[], ...names: string[]) => {
  const lower = new Set(headers.map((h) => h.toLowerCase()))
  return names.every((n) => lower.has(n))
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function hostName(url: string): string {
  try { return new URL(url.includes('://') ? url : `https://${url}`).hostname.replace(/^www\./, '') } catch { return url }
}

/** An otpauth:// URI or a bare base32 key, as a base32 key. */
export function totpKey(value: string | undefined): string | undefined {
  if (!value) return undefined
  const v = value.trim()
  if (v.toLowerCase().startsWith('otpauth://')) {
    const m = v.match(/[?&]secret=([^&]+)/i)
    return m ? decodeURIComponent(m[1]!).replace(/\s/g, '').toUpperCase() : undefined
  }
  const bare = v.replace(/\s/g, '').toUpperCase()
  return /^[A-Z2-7]+=*$/.test(bare) ? bare : undefined
}

const truthy = (v: string | undefined) => /^(1|true|yes|y|on)$/i.test(v ?? '')
const splitTags = (v: string | undefined) => (v ?? '').split(/[;,]/).map((t) => t.trim()).filter(Boolean)

function blankItem(name: string, type: EntryType = 'login'): ImportedItem {
  return { name, type, customFields: [], tags: [], favorite: false, folder: '' }
}

/** Drops empty optional values so imported entries carry no noise. */
function tidy(item: ImportedItem): ImportedItem {
  const out: ImportedItem = { ...item, name: item.name.trim() || hostName(item.url ?? '') || 'Imported item' }
  for (const k of ['username', 'password', 'url', 'notes', 'totpSecret'] as const) {
    if (!out[k]) delete out[k]
  }
  if (out.fields) {
    out.fields = Object.fromEntries(Object.entries(out.fields).filter(([, v]) => v))
    if (!Object.keys(out.fields).length) delete out.fields
  }
  out.customFields = out.customFields.filter((c) => c.label || c.value)
  return out
}

function normaliseFolder(path: string, separator: RegExp): string {
  return path.split(separator).map((p) => p.trim()).filter(Boolean).join(' / ')
}

function folderList(items: ImportedItem[]): string[] {
  const all = new Set<string>()
  for (const it of items) {
    const parts = it.folder ? it.folder.split(' / ') : []
    for (let i = 1; i <= parts.length; i++) all.add(parts.slice(0, i).join(' / '))
  }
  return [...all].sort((a, b) => a.split(' / ').length - b.split(' / ').length || a.localeCompare(b))
}

// ── Formats ─────────────────────────────────────────────────────────────────

function bitwardenJson(json: Record<string, unknown>): ImportResult {
  if (json['encrypted'] === true) {
    throw new ImportError('This Bitwarden export is password-protected. Export again from Bitwarden as "JSON" (not "JSON (Encrypted)").')
  }
  const folderNames = new Map<string, string>()
  for (const f of (json['folders'] as { id: string; name: string }[] | undefined) ?? []) folderNames.set(f.id, f.name)
  const warnings: string[] = []
  const items = ((json['items'] as Record<string, any>[] | undefined) ?? []).map((raw): ImportedItem => {
    const it = blankItem(String(raw['name'] ?? ''))
    it.notes = raw['notes'] ?? undefined
    it.favorite = raw['favorite'] === true
    it.folder = normaliseFolder(folderNames.get(raw['folderId']) ?? '', /\//)
    it.customFields = ((raw['fields'] as { name?: string; value?: string; type?: number }[] | undefined) ?? [])
      .map((f) => ({ label: f.name ?? '', value: String(f.value ?? ''), hidden: f.type === 1 }))
    switch (raw['type']) {
      case 1: {
        const login = raw['login'] ?? {}
        it.username = login.username ?? undefined
        it.password = login.password ?? undefined
        it.url = login.uris?.[0]?.uri ?? undefined
        it.totpSecret = totpKey(login.totp)
        for (const extra of (login.uris ?? []).slice(1)) it.customFields.push({ label: 'Website', value: extra.uri, hidden: false })
        break
      }
      case 2: it.type = 'note'; break
      case 3: {
        const c = raw['card'] ?? {}
        it.type = 'card'
        const yy = String(c.expYear ?? '').slice(-2)
        const mm = String(c.expMonth ?? '').padStart(2, '0')
        it.fields = { cardholder: c.cardholderName ?? '', number: c.number ?? '', expiry: yy && c.expMonth ? `${mm}/${yy}` : '', cvv: c.code ?? '' }
        break
      }
      case 4: {
        const d = raw['identity'] ?? {}
        it.type = 'identity'
        const address = [d.address1, d.address2, d.address3, [d.city, d.state, d.postalCode].filter(Boolean).join(' '), d.country].filter(Boolean).join('\n')
        it.fields = {
          fullName: [d.title, d.firstName, d.middleName, d.lastName].filter(Boolean).join(' '),
          email: d.email ?? '', phone: d.phone ?? '', address, company: d.company ?? '',
          nationalId: d.ssn ?? d.passportNumber ?? d.licenseNumber ?? '',
        }
        break
      }
      default:
        warnings.push(`"${it.name}" is of a kind this import does not know; kept as a secure note.`)
        it.type = 'note'
    }
    return tidy(it)
  })
  return { format: 'Bitwarden (JSON)', items, folders: folderList(items), warnings }
}

function bitwardenCsv(data: Row[]): ImportedItem[] {
  return data.map((r) => {
    const it = blankItem(r['name'] ?? '', r['type'] === 'note' ? 'note' : 'login')
    it.notes = r['notes']
    it.favorite = truthy(r['favorite'])
    it.folder = normaliseFolder(r['folder'] ?? '', /\//)
    it.username = r['login_username']
    it.password = r['login_password']
    it.url = (r['login_uri'] ?? '').split(',')[0]
    it.totpSecret = totpKey(r['login_totp'])
    it.customFields = (r['fields'] ?? '').split('\n').filter(Boolean).map((line) => {
      const i = line.indexOf(': ')
      return i < 0 ? { label: line, value: '', hidden: false } : { label: line.slice(0, i), value: line.slice(i + 2), hidden: false }
    })
    return tidy(it)
  })
}

function lastPass(data: Row[]): ImportedItem[] {
  return data.map((r) => {
    // LastPass marks secure notes with the URL "http://sn".
    const note = r['url'] === 'http://sn'
    const it = blankItem(r['name'] ?? '', note ? 'note' : 'login')
    if (!note) {
      it.url = r['url']
      it.username = r['username']
      it.password = r['password']
      it.totpSecret = totpKey(r['totp'])
    }
    it.notes = r['extra']
    it.favorite = truthy(r['fav'])
    it.folder = normaliseFolder(r['grouping'] ?? '', /[\\/]/)
    return tidy(it)
  })
}

function onePassword(data: Row[]): ImportedItem[] {
  return data.map((r) => {
    const it = blankItem(r['title'] ?? '')
    it.url = r['url']
    it.username = r['username']
    it.password = r['password']
    it.totpSecret = totpKey(r['otpauth'])
    it.notes = r['notes']
    it.favorite = truthy(r['favorite'])
    it.tags = splitTags(r['tags'])
    if (truthy(r['archived'])) it.tags.push('archived')
    return tidy(it)
  })
}

function keePass(data: Row[]): ImportedItem[] {
  return data.map((r) => {
    const it = blankItem(r['title'] ?? '')
    it.username = r['username']
    it.password = r['password']
    it.url = r['url']
    it.notes = r['notes']
    it.totpSecret = totpKey(r['totp'])
    // KeePass groups start at the database root ("Root/Internet").
    it.folder = normaliseFolder((r['group'] ?? '').replace(/^Root\/?/i, ''), /\//)
    return tidy(it)
  })
}

function browser(data: Row[], firefox: boolean): ImportedItem[] {
  return data.map((r) => {
    const url = r['url'] ?? ''
    const it = blankItem(firefox ? hostName(url) : (r['name'] ?? r['title'] ?? ''))
    it.url = url
    it.username = r['username']
    it.password = r['password']
    it.notes = r['note'] ?? r['notes']
    it.totpSecret = totpKey(r['otpauth'])
    return tidy(it)
  })
}

/** Zoho Vault puts the username and password inside a "SecretData" column as
 *  "Key:Value" lines. Read it, and keep anything else in it as fields. */
function zohoVault(data: Row[]): ImportedItem[] {
  return data.map((r) => {
    const it = blankItem(r['password name'] ?? '')
    it.url = r['password url'] ?? r['url']
    it.notes = [r['description'], r['notes']].filter(Boolean).join('\n\n')
    it.tags = splitTags(r['tags'])
    it.favorite = truthy(r['favorite'])
    it.totpSecret = totpKey(r['totp'])
    it.folder = normaliseFolder(r['chambername'] ?? r['folder name'] ?? '', /\//)
    for (const line of (r['secretdata'] ?? '').split(/\r?\n/)) {
      const i = line.indexOf(':')
      if (i < 0) continue
      const key = line.slice(0, i).trim()
      const value = line.slice(i + 1).trim()
      if (/^(user ?name|username|login|email)$/i.test(key)) it.username = value
      else if (/^password$/i.test(key)) it.password = value
      else if (key && value) it.customFields.push({ label: key, value, hidden: /pass|secret|pin|key|token/i.test(key) })
    }
    return tidy(it)
  })
}

/** Last resort: guess which column is which from its name. */
function generic(headers: string[], data: Row[]): ImportedItem[] | null {
  const lower = headers.map((h) => h.toLowerCase())
  const find = (re: RegExp) => lower.find((h) => re.test(h))
  const col = {
    name: find(/^(name|title|account|site|entry)/),
    url: find(/(url|website|web site|uri|login_uri|address)/),
    username: find(/(user|login|email)/),
    password: find(/pass/),
    notes: find(/(note|comment|extra|description)/),
    totp: find(/(totp|otp|2fa)/),
    folder: find(/(folder|group|category)/),
  }
  if (!col.password || !(col.name || col.url)) return null
  return data.map((r) => {
    const it = blankItem(col.name ? r[col.name] ?? '' : '')
    it.url = col.url ? r[col.url] : undefined
    it.username = col.username ? r[col.username] : undefined
    it.password = r[col.password!]
    it.notes = col.notes ? r[col.notes] : undefined
    it.totpSecret = col.totp ? totpKey(r[col.totp]) : undefined
    it.folder = col.folder ? normaliseFolder(r[col.folder] ?? '', /[\\/]/) : ''
    return tidy(it)
  })
}

// ── Entry point ─────────────────────────────────────────────────────────────

/** Reads a file's text and returns what it holds. Throws ImportError for a
 *  file that is recognisably wrong (an encrypted export, nothing usable). */
export function readImport(text: string): ImportResult {
  const trimmed = text.trim()
  if (!trimmed) throw new ImportError('The file is empty.')

  if (trimmed.startsWith('{')) {
    let json: Record<string, unknown>
    try { json = JSON.parse(trimmed) as Record<string, unknown> } catch { throw new ImportError('The file looks like JSON but could not be read.') }
    if (Array.isArray(json['items'])) return bitwardenJson(json)
    if (json['format'] === 'vault-export') throw new ImportError('This is an encrypted Vault export; it needs its export password.')
    throw new ImportError('This JSON file is not a format Vault can import.')
  }

  const { headers, data } = records(parseCsv(text))
  if (!headers.length || !data.length) throw new ImportError('No rows were found in the file.')
  const detected = ((): [string, ImportedItem[]] | null => {
    if (has(headers, 'login_password', 'login_username')) return ['Bitwarden (CSV)', bitwardenCsv(data)]
    if (has(headers, 'url', 'username', 'password', 'extra', 'grouping')) return ['LastPass', lastPass(data)]
    if (has(headers, 'title', 'url', 'username', 'password', 'otpauth', 'favorite')) return ['1Password', onePassword(data)]
    if (has(headers, 'group', 'title', 'username', 'password')) return ['KeePass / KeePassXC', keePass(data)]
    if (has(headers, 'password name')) return ['Zoho Vault', zohoVault(data)]
    if (has(headers, 'url', 'username', 'password', 'httprealm')) return ['Firefox', browser(data, true)]
    if (has(headers, 'title', 'url', 'username', 'password')) return ['Safari', browser(data, false)]
    if (has(headers, 'name', 'url', 'username', 'password')) return ['Chrome, Edge or Brave', browser(data, false)]
    const g = generic(headers, data)
    return g ? ['CSV (columns guessed from their names)', g] : null
  })()
  if (!detected) throw new ImportError('Vault could not tell which column holds what. The file needs at least a name or website column and a password column.')
  const [format, items] = detected
  const warnings = format.startsWith('CSV (') ? ['The columns were guessed from their names. Check a few entries after importing.'] : []
  return { format, items, folders: folderList(items), warnings }
}

/** Items already in the vault with the same name, username and website. */
export function duplicateKey(e: { name: string; username?: string | undefined; url?: string | undefined }): string {
  return [e.name.trim().toLowerCase(), (e.username ?? '').trim().toLowerCase(), hostName(e.url ?? '').toLowerCase()].join('\u0000')
}
