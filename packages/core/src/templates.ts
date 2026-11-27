// Item templates: a person's own kinds of item, such as "Office laptop" or
// "Vendor account". A template is a name, a built-in type to start from, and
// the labelled fields to add; choosing it in the editor fills them in. Kept in
// the sealed preferences, so it follows the account and the server sees none
// of it. Items made from one remember its id, for the sidebar.

import { TYPE_SPECS } from './items.js'

export interface TemplateField { label: string; hidden: boolean }
export interface ItemTemplate { id: string; name: string; base: string; fields: TemplateField[] }

export const TEMPLATES_MAX = 20
export const TEMPLATE_FIELDS_MAX = 20
const NAME_MAX = 40
const LABEL_MAX = 40

const clip = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** Templates read from storage: only well-formed ones, tidied. */
export function normalizeTemplates(raw: unknown): ItemTemplate[] {
  if (!Array.isArray(raw)) return []
  const out: ItemTemplate[] = []
  const ids = new Set<string>()
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue
    const r = t as Record<string, unknown>
    const id = typeof r['id'] === 'string' && /^[A-Za-z0-9-]{1,40}$/.test(r['id']) ? r['id'] : ''
    const name = clip(r['name'], NAME_MAX)
    if (!id || !name || ids.has(id)) continue
    const base = TYPE_SPECS.some((s) => s.type === r['base']) ? (r['base'] as string) : 'login'
    const fields: TemplateField[] = []
    for (const f of Array.isArray(r['fields']) ? r['fields'] : []) {
      const label = clip((f as Record<string, unknown>)?.['label'], LABEL_MAX)
      if (!label || fields.some((x) => x.label.toLowerCase() === label.toLowerCase())) continue
      fields.push({ label, hidden: (f as Record<string, unknown>)['hidden'] === true })
      if (fields.length >= TEMPLATE_FIELDS_MAX) break
    }
    ids.add(id)
    out.push({ id, name, base, fields })
    if (out.length >= TEMPLATES_MAX) break
  }
  return out
}

/** A draft item changed to follow a template: its base type, and each of the
 *  template's fields, keeping any value already typed under the same label
 *  and any other custom field the person added. */
export function applyTemplate<T extends { type: string; customFields: { label: string; value: string; hidden: boolean }[]; template?: string | undefined }>(draft: T, template: ItemTemplate): T & { template: string } {
  const existing = new Map(draft.customFields.map((c) => [c.label.toLowerCase(), c]))
  const fromTemplate = template.fields.map((f) => ({ label: f.label, value: existing.get(f.label.toLowerCase())?.value ?? '', hidden: f.hidden }))
  const labels = new Set(template.fields.map((f) => f.label.toLowerCase()))
  const extra = draft.customFields.filter((c) => !labels.has(c.label.toLowerCase()) && (c.label.trim() || c.value.trim()))
  // The base was checked against the built-in types when the template was read.
  return { ...draft, type: template.base as T['type'], template: template.id, customFields: [...fromTemplate, ...extra] }
}
