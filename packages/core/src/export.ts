// Plain CSV export, in Bitwarden's import format: the most widely accepted
// layout among password managers, so a vault can leave as easily as it came.
//
// Bitwarden's CSV knows logins and notes only. Other types export as notes,
// with their fields written into the "fields" column, so nothing is lost even
// if the receiving manager files them as notes.

import { type EntryLike, readField, typeSpec } from './items.js'

const HEADERS = ['folder', 'favorite', 'type', 'name', 'notes', 'fields', 'reprompt', 'login_uri', 'login_username', 'login_password', 'login_totp']

function cell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

export interface ExportEntry extends EntryLike {
  favorite?: boolean
  /** Folder path, " / " separated. */
  folder?: string
}

export function toCsv(entries: readonly ExportEntry[]): string {
  const lines = [HEADERS.join(',')]
  for (const e of entries) {
    const login = e.type === 'login' || e.type === 'wifi'
    const spec = typeSpec(e.type)
    // Login and Wi-Fi keep their main values in Bitwarden's login columns;
    // anything else of theirs (Wi-Fi security) goes in "fields" like other types.
    const typeFields = spec.fields
      .filter((f) => !login || f.at === 'fields')
      .map((f) => [f.label, readField(e, f)] as const)
      .filter(([, v]) => v)
    const fields = [...typeFields, ...(e.customFields ?? []).map((c) => [c.label, c.value] as const)]
      .map(([k, v]) => `${k}: ${v}`).join('\n')
    lines.push([
      (e.folder ?? '').split(' / ').join('/'),
      e.favorite ? '1' : '',
      login ? 'login' : 'note',
      e.name,
      e.notes ?? '',
      fields,
      '0',
      login ? e.url ?? '' : '',
      login ? e.username ?? '' : '',
      login ? e.password ?? '' : '',
      login ? e.totpSecret ?? '' : '',
    ].map(cell).join(','))
  }
  return `${lines.join('\r\n')}\r\n`
}
