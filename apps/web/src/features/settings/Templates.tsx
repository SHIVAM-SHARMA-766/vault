// Item templates (Preferences): a person's own kinds of item. Each is a name,
// a built-in type to start from and the labelled fields to add; the editor
// offers them beside the built-in types. Saved sealed with the preferences.

import { useState } from 'react'

import { type ItemTemplate, type Prefs, TEMPLATES_MAX, TEMPLATE_FIELDS_MAX, typesByGroup } from '@vault/core'

import { IconNote, IconPlus, IconTrash, IconX } from '../../ui/icons.js'
import { Check } from '../../ui/kit.js'

const newId = () => (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`).slice(0, 36)
const blank = (): ItemTemplate => ({ id: newId(), name: '', base: 'note', fields: [{ label: '', hidden: false }] })

export function Templates({ p, saving, change }: { p: Prefs; saving: boolean; change: (n: Partial<Prefs>) => Promise<void> }) {
  const [editing, setEditing] = useState<ItemTemplate | null>(null)
  const [error, setError] = useState('')

  async function save() {
    if (!editing) return
    const t = { ...editing, name: editing.name.trim(), fields: editing.fields.map((f) => ({ ...f, label: f.label.trim() })).filter((f) => f.label) }
    if (!t.name) return setError('Give the template a name.')
    if (!t.fields.length) return setError('Add at least one field.')
    const labels = t.fields.map((f) => f.label.toLowerCase())
    if (new Set(labels).size !== labels.length) return setError('Two fields have the same label.')
    if (p.templates.some((x) => x.id !== t.id && x.name.toLowerCase() === t.name.toLowerCase())) return setError('A template with that name already exists.')
    const exists = p.templates.some((x) => x.id === t.id)
    await change({ templates: exists ? p.templates.map((x) => (x.id === t.id ? t : x)) : [...p.templates, t] })
    setEditing(null); setError('')
  }

  const setField = (i: number, next: Partial<ItemTemplate['fields'][number]>) =>
    setEditing((e) => e && { ...e, fields: e.fields.map((f, j) => (j === i ? { ...f, ...next } : f)) })

  return (
    <section className="settings-card" aria-labelledby="p-templates">
      <div className="settings-card-head"><IconNote size={18} /><h2 id="p-templates">Item templates</h2></div>
      <p className="muted small">Your own kinds of item, like "Office laptop" or "Vendor account": a type to start from and the fields to fill in. New item offers them beside the built-in types.</p>

      {p.templates.length ? (
        <ul className="template-list">
          {p.templates.map((t) => (
            <li key={t.id}>
              <span className="template-name">{t.name}</span>
              <span className="muted small">{t.fields.length} field{t.fields.length === 1 ? '' : 's'} · from {labelOf(t.base)}</span>
              <button type="button" className="btn btn-secondary btn-sm" disabled={saving || !!editing} onClick={() => { setEditing(t); setError('') }}>Edit</button>
              <button type="button" className="icon-btn icon-danger" aria-label={`Delete template ${t.name}`} disabled={saving || !!editing}
                      onClick={() => { if (confirm(`Delete the template “${t.name}”? Items made from it keep their fields.`)) void change({ templates: p.templates.filter((x) => x.id !== t.id) }) }}>
                <IconTrash size={15} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {editing ? (
        <div className="template-editor">
          <div className="grid-2">
            <div className="field">
              <label htmlFor="tpl-name">Template name</label>
              <input id="tpl-name" maxLength={40} value={editing.name} placeholder="e.g. Office laptop" onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="tpl-base">Starts from</label>
              <select id="tpl-base" value={editing.base} onChange={(e) => setEditing({ ...editing, base: e.target.value })}>
                {typesByGroup().map(({ group, types }) => (
                  <optgroup key={group} label={group}>{types.map((ty) => <option key={ty.type} value={ty.type}>{ty.label}</option>)}</optgroup>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <span className="field-label-text">Fields</span>
            <ul className="template-fields">
              {editing.fields.map((f, i) => (
                <li key={i}>
                  <input aria-label={`Field ${i + 1} label`} maxLength={40} placeholder="Label, e.g. Serial number" value={f.label} onChange={(e) => setField(i, { label: e.target.value })} />
                  <Check checked={f.hidden} onChange={(v) => setField(i, { hidden: v })}>Hidden</Check>
                  <button type="button" className="icon-btn" aria-label={`Remove field ${i + 1}`} disabled={editing.fields.length === 1}
                          onClick={() => setEditing({ ...editing, fields: editing.fields.filter((_, j) => j !== i) })}><IconX size={14} /></button>
                </li>
              ))}
            </ul>
            {editing.fields.length < TEMPLATE_FIELDS_MAX ? (
              <button type="button" className="link" onClick={() => setEditing({ ...editing, fields: [...editing.fields, { label: '', hidden: false }] })}><IconPlus size={13} /> Add a field</button>
            ) : null}
          </div>
          {error ? <p className="alert alert-error" role="alert">{error}</p> : null}
          <div className="settings-actions">
            <button type="button" className="btn btn-secondary" onClick={() => { setEditing(null); setError('') }}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save()}>Save template</button>
          </div>
        </div>
      ) : (
        <div className="settings-actions settings-actions-left">
          <button type="button" className="btn btn-secondary" disabled={saving || p.templates.length >= TEMPLATES_MAX} onClick={() => { setEditing(blank()); setError('') }}>
            <IconPlus size={15} />New template
          </button>
        </div>
      )}
    </section>
  )
}

function labelOf(type: string): string {
  for (const g of typesByGroup()) for (const t of g.types) if (t.type === type) return t.label
  return type
}
