// Creating and editing an entry. The fields come from the entry type's spec
// (packages/core), so a card asks for a card's things and an SSH key for an
// SSH key's. Custom fields cover everything else.

import { useMemo, useState } from 'react'

import type { CustomField, EntryContent, EntryType } from '@vault/crypto'
import { flattenTree, typesByGroup, folderTree, readField, typeSpec, writeField } from '@vault/core'

import { IconEye, IconEyeOff, IconPlus, IconX } from '../../ui/icons.js'
import { FieldInput } from './fields.js'
import type { Folder } from './model.js'

export function EntryForm({ initial, id, folders, onCancel, onSave, shared = false }: {
  initial: EntryContent
  id?: string | undefined
  /** A shared item: no personal folder; encrypted under its collection's key. */
  shared?: boolean
  folders: Folder[]
  onCancel: () => void
  onSave: (content: EntryContent, id?: string) => Promise<boolean>
}) {
  const [draft, setDraft] = useState<EntryContent>(initial)
  const [saving, setSaving] = useState(false)
  const [tagText, setTagText] = useState(initial.tags.join(', '))
  const spec = typeSpec(draft.type)
  const folderOptions = useMemo(() => flattenTree(folderTree(folders)), [folders])

  const set = <K extends keyof EntryContent>(k: K, v: EntryContent[K]) => setDraft((d) => ({ ...d, [k]: v }))
  const setCustom = (i: number, patch: Partial<CustomField>) =>
    set('customFields', draft.customFields.map((c, j) => (j === i ? { ...c, ...patch } : c)))

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    const tags = [...new Set(tagText.split(',').map((t) => t.trim()).filter(Boolean))]
    // Drop empty type fields and nameless custom fields rather than storing noise.
    const fields = Object.fromEntries(Object.entries(draft.fields ?? {}).filter(([, v]) => v.trim() !== ''))
    const customFields = draft.customFields.filter((c) => c.label.trim() || c.value.trim())
    const { folderId, ...rest } = draft
    const ok = await onSave({ ...rest, ...(folderId ? { folderId } : {}), tags, fields, customFields }, id)
    if (!ok) setSaving(false)
  }

  return (
    <form className="editor" onSubmit={submit}>
      <div className="detail-bar">
        <h2>{id ? 'Edit item' : 'New item'}</h2>
        <button type="button" className="icon-btn" onClick={onCancel} aria-label="Close"><IconX size={18} /></button>
      </div>

      <div className="editor-body">
        <div className="grid-2">
          <div className="field">
            <label htmlFor="f-type">Type</label>
            <select id="f-type" value={draft.type} onChange={(e) => set('type', e.target.value as EntryType)}>
              {typesByGroup().map(({ group, types }) => (
                <optgroup key={group} label={group}>
                  {types.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
                </optgroup>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-name">Name</label>
            <input id="f-name" required autoFocus placeholder={spec.type === 'card' ? 'e.g. HDFC Millennia' : 'e.g. GitHub'}
                   value={draft.name} onChange={(e) => set('name', e.target.value)} />
          </div>
        </div>

        {spec.fields.length ? (
          <div className={`type-fields type-${spec.type}`}>
            {spec.fields.map((field) => (
              <FieldInput key={field.key} spec={field} value={readField(draft, field)}
                          onChange={(v) => setDraft((d) => writeField(d, field, v))} />
            ))}
          </div>
        ) : null}

        {spec.fields.some((f) => f.at === 'password') ? (
          <div className="field">
            <label htmlFor="f-rotate">Remind me to change the password</label>
            <select id="f-rotate" value={draft.rotateDays ?? ''} onChange={(e) => {
              const v = e.target.value
              setDraft((d) => { const { rotateDays: _r, ...rest } = d; return v ? { ...rest, rotateDays: Number(v) } : rest })
            }}>
              <option value="">Never</option>
              <option value="30">Every 30 days</option>
              <option value="90">Every 90 days</option>
              <option value="180">Every 6 months</option>
              <option value="365">Every year</option>
            </select>
          </div>
        ) : null}

        <div className="field">
          <label htmlFor="f-notes">Notes</label>
          <textarea id="f-notes" rows={spec.type === 'note' ? 10 : 3} value={draft.notes ?? ''}
                    onChange={(e) => set('notes', e.target.value)} />
        </div>

        <div className="field custom-fields">
          <div className="label-row"><label>Custom fields</label></div>
          {draft.customFields.map((c, i) => (
            <div key={i} className="custom-row">
              <input aria-label={`Custom field ${i + 1} name`} placeholder="Name, e.g. Port" value={c.label}
                     onChange={(e) => setCustom(i, { label: e.target.value })} />
              <input aria-label={`Custom field ${i + 1} value`} placeholder="Value" value={c.value}
                     type={c.hidden ? 'password' : 'text'} className={c.hidden ? 'mono' : ''} autoComplete="off" spellCheck={false}
                     onChange={(e) => setCustom(i, { value: e.target.value })} />
              <button type="button" className="icon-btn" title={c.hidden ? 'Hidden field — click to make it visible' : 'Visible field — click to hide it'}
                      aria-label={c.hidden ? `Make custom field ${i + 1} visible` : `Hide custom field ${i + 1}`}
                      onClick={() => setCustom(i, { hidden: !c.hidden })}>
                {c.hidden ? <IconEyeOff size={16} /> : <IconEye size={16} />}
              </button>
              <button type="button" className="icon-btn icon-danger" aria-label={`Remove custom field ${i + 1}`}
                      onClick={() => set('customFields', draft.customFields.filter((_, j) => j !== i))}>
                <IconX size={16} />
              </button>
            </div>
          ))}
          <button type="button" className="btn btn-secondary btn-sm"
                  onClick={() => set('customFields', [...draft.customFields, { label: '', value: '', hidden: false }])}>
            <IconPlus size={15} />Add field
          </button>
        </div>

        <div className="grid-2">
          {shared ? <div className="field"><label>Folder</label><p className="muted small">Shared items live in their collection.</p></div> : <div className="field">
            <label htmlFor="f-folder">Folder</label>
            <select id="f-folder" value={draft.folderId ?? ''} onChange={(e) => set('folderId', e.target.value || undefined)}>
              <option value="">No folder</option>
              {folderOptions.map((n) => (
                <option key={n.folder.id} value={n.folder.id}>{'  '.repeat(n.depth)}{n.folder.name}</option>
              ))}
            </select>
          </div>}
          <div className="field">
            <label htmlFor="f-tags">Tags</label>
            <input id="f-tags" placeholder="work, personal" value={tagText} onChange={(e) => setTagText(e.target.value)} />
          </div>
        </div>
        <p className="hint">{shared ? 'Encrypted with the collection’s key before it is saved: readable by the people who can open the collection, never by the server.' : 'Everything here — names, folders, tags and fields — is encrypted before it is saved.'}</p>
      </div>

      <div className="editor-foot">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={!draft.name.trim() || saving}>
          {saving ? <><span className="spinner" />Encrypting…</> : 'Save'}
        </button>
      </div>
    </form>
  )
}
