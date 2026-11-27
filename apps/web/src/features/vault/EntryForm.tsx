// Creating and editing an entry. The fields come from the entry type's spec
// (packages/core), so a card asks for a card's things and an SSH key for an
// SSH key's. Custom fields cover everything else.

import { useMemo, useRef, useState } from 'react'

import type { CustomField, EntryContent, EntryType } from '@vault/crypto'
import { RELATED_MAX, applyTemplate, cleanRelated, flattenTree, typesByGroup, folderTree, readField, typeSpec, writeField } from '@vault/core'

import { IconEye, IconEyeOff, IconPlus, IconX } from '../../ui/icons.js'
import { FieldInput } from './fields.js'
import { Markdown } from '../../ui/Markdown.js'
import { ATTACHMENT_MAX_BYTES, deleteAttachments, describeSize, uploadAttachment } from '../../lib/attachments.js'
import { IconUpload } from '../../ui/icons.js'
import type { Folder } from './model.js'
import { t } from '../../lib/i18n.js'
import { Monogram } from '../../ui/kit.js'
import { usePrefs } from '../../lib/prefs.js'

/** An item that can be linked from the editor: enough to find and show it. */
export interface LinkCandidate { id: string; name: string; type: EntryType; username?: string | undefined; url?: string | undefined }

export function EntryForm({ initial, id, folders, onCancel, onSave, shared = false, candidates = [] }: {
  initial: EntryContent
  id?: string | undefined
  /** Items this one may be linked to: the same place (personal, or the same collection). */
  candidates?: LinkCandidate[]
  /** A shared item: no personal folder; encrypted under its collection's key. */
  shared?: boolean
  folders: Folder[]
  onCancel: () => void
  onSave: (content: EntryContent, id?: string) => Promise<boolean>
}) {
  const [draft, setDraft] = useState<EntryContent>(initial)
  const [saving, setSaving] = useState(false)
  const [preview, setPreview] = useState(false)
  const [tagText, setTagText] = useState(initial.tags.join(', '))
  // Attachments (D2): uploaded as soon as they are picked; on cancel, the new
  // ones are deleted again, and on save, the ones removed from the list.
  const original = useRef((initial.attachments ?? []).map((a) => a.id))
  const [added, setAdded] = useState<string[]>([])
  const [uploading, setUploading] = useState('')
  const [attachError, setAttachError] = useState('')
  const cancel = () => { void deleteAttachments(added); onCancel() }
  const spec = typeSpec(draft.type)
  const folderOptions = useMemo(() => flattenTree(folderTree(folders)), [folders])

  const set = <K extends keyof EntryContent>(k: K, v: EntryContent[K]) => setDraft((d) => ({ ...d, [k]: v }))
  // The person's own templates, offered first in the type list.
  const templates = usePrefs().templates
  const template = draft.template ? templates.find((x) => x.id === draft.template) : undefined
  const chooseType = (value: string) => {
    const tp = value.startsWith('tpl:') ? templates.find((x) => x.id === value.slice(4)) : undefined
    if (tp) { setDraft((d) => applyTemplate(d, tp)); return }
    setDraft((d) => { const { template: _gone, ...rest } = d; return { ...rest, type: value as EntryType } })
  }
  const setCustom = (i: number, patch: Partial<CustomField>) =>
    set('customFields', draft.customFields.map((c, j) => (j === i ? { ...c, ...patch } : c)))

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    const tags = [...new Set(tagText.split(',').map((t) => t.trim()).filter(Boolean))]
    // Drop empty type fields and nameless custom fields rather than storing noise.
    const fields = Object.fromEntries(Object.entries(draft.fields ?? {}).filter(([, v]) => v.trim() !== ''))
    const customFields = draft.customFields.filter((c) => c.label.trim() || c.value.trim())
    const { folderId, related: rawRelated, ...rest } = draft
    const related = cleanRelated(id, rawRelated)
    const ok = await onSave({ ...rest, ...(folderId ? { folderId } : {}), ...(related.length ? { related } : {}), tags, fields, customFields }, id)
    if (!ok) { setSaving(false); return }
    const kept = new Set((draft.attachments ?? []).map((a) => a.id))
    void deleteAttachments(original.current.filter((x) => !kept.has(x)))
  }

  return (
    <form className="editor" onSubmit={submit}>
      <div className="detail-bar">
        <h2>{id ? 'Edit item' : 'New item'}</h2>
        <button type="button" className="icon-btn" onClick={cancel} aria-label="Close"><IconX size={18} /></button>
      </div>

      <div className="editor-body">
        <div className="grid-2">
          <div className="field">
            <label htmlFor="f-type">{t('Type')}</label>
            <select id="f-type" value={template ? `tpl:${template.id}` : draft.type} onChange={(e) => chooseType(e.target.value)}>
              {templates.length ? (
                <optgroup label="My templates">
                  {templates.map((tp) => <option key={tp.id} value={`tpl:${tp.id}`}>{tp.name}</option>)}
                </optgroup>
              ) : null}
              {typesByGroup().map(({ group, types }) => (
                <optgroup key={group} label={group}>
                  {types.map((ty) => <option key={ty.type} value={ty.type}>{t(ty.label)}</option>)}
                </optgroup>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-name">{t('Name')}</label>
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
          <div className="label-row">
            <label htmlFor="f-notes">{t('Notes')}</label>
            {draft.notes?.trim() ? <button type="button" className="link" onClick={() => setPreview((v) => !v)}>{preview ? 'Edit' : 'Preview'}</button> : null}
          </div>
          {preview && draft.notes?.trim()
            ? <Markdown source={draft.notes} className="notes-preview" />
            : <textarea id="f-notes" rows={spec.type === 'note' ? 10 : 3} value={draft.notes ?? ''} aria-describedby="f-notes-hint"
                        onChange={(e) => set('notes', e.target.value)} />}
          <p id="f-notes-hint" className="hint">Markdown works: <code># heading</code> <code>**bold**</code> <code>- list</code> <code>- [ ] checklist</code> <code>[link](https://…)</code></p>
        </div>

        {candidates.length || draft.related?.length ? (
          <RelatedPicker selfId={id} value={draft.related ?? []} candidates={candidates} onChange={(related) => set('related', related)} />
        ) : null}

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
            <IconPlus size={15} />{t('Add field')}
          </button>
        </div>

        {(draft.passkeys ?? []).length ? (
          <div className="field">
            <span className="field-label">Passkeys</span>
            <ul className="attachment-list passkey-list">
              {(draft.passkeys ?? []).map((p) => (
                <li key={p.credentialId}>
                  <span className="truncate">{p.userDisplayName || p.userName} · {p.rpId}</span>
                  <button type="button" className="icon-btn icon-sm" aria-label={`Remove the passkey for ${p.userName}`}
                          onClick={() => set('passkeys', (draft.passkeys ?? []).filter((x) => x.credentialId !== p.credentialId))}><IconX size={14} /></button>
                </li>
              ))}
            </ul>
            <p className="hint">Removing one here does not remove it from the site: remove it in the site's security settings too.</p>
          </div>
        ) : null}

        {!shared ? (
          <div className="field attachments">
            <span className="field-label">{t('Attachments')}</span>
            {(draft.attachments ?? []).length ? (
              <ul className="attachment-list">
                {(draft.attachments ?? []).map((a) => (
                  <li key={a.id}>
                    <span className="truncate">{a.name}</span><span className="muted small">{describeSize(a.size)}</span>
                    <button type="button" className="icon-btn icon-sm" aria-label={`Remove ${a.name}`} onClick={() => set('attachments', (draft.attachments ?? []).filter((x) => x.id !== a.id))}><IconX size={14} /></button>
                  </li>
                ))}
              </ul>
            ) : null}
            <label className="btn btn-secondary btn-sm attach-btn">
              <IconUpload size={15} />{uploading ? `Encrypting ${uploading}…` : 'Attach a file'}
              <input type="file" className="visually-hidden" aria-label="Attach a file" disabled={!!uploading} onChange={async (e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (!file) return
                setAttachError('')
                if (file.size > ATTACHMENT_MAX_BYTES) { setAttachError(`${file.name} is larger than 2 MB.`); return }
                setUploading(file.name)
                try {
                  const ref = await uploadAttachment(file)
                  setAdded((x) => [...x, ref.id])
                  setDraft((d) => ({ ...d, attachments: [...(d.attachments ?? []), ref] }))
                } catch (err) { setAttachError(err instanceof Error ? err.message : 'Could not attach it.') }
                finally { setUploading('') }
              }} />
            </label>
            {attachError ? <p className="alert alert-error small">{attachError}</p> : null}
            <p className="hint">Up to 2 MB a file. Each is encrypted here with its own key before it is uploaded.</p>
          </div>
        ) : null}

        <div className="grid-2">
          {shared ? <div className="field"><label>{t('Folder')}</label><p className="muted small">Shared items live in their collection.</p></div> : <div className="field">
            <label htmlFor="f-folder">{t('Folder')}</label>
            <select id="f-folder" value={draft.folderId ?? ''} onChange={(e) => set('folderId', e.target.value || undefined)}>
              <option value="">{t('No folder')}</option>
              {folderOptions.map((n) => (
                <option key={n.folder.id} value={n.folder.id}>{'  '.repeat(n.depth)}{n.folder.name}</option>
              ))}
            </select>
          </div>}
          <div className="field">
            <label htmlFor="f-tags">{t('Tags')}</label>
            <input id="f-tags" placeholder="work, personal" value={tagText} onChange={(e) => setTagText(e.target.value)} />
          </div>
        </div>
        <p className="hint">{shared ? 'Encrypted with the collection’s key before it is saved: readable by the people who can open the collection, never by the server.' : 'Everything here — names, folders, tags and fields — is encrypted before it is saved.'}</p>
      </div>

      <div className="editor-foot">
        <button type="button" className="btn btn-secondary" onClick={cancel}>{t('Cancel')}</button>
        <button type="submit" className="btn btn-primary" disabled={!draft.name.trim() || saving}>
          {saving ? <><span className="spinner" />Encrypting…</> : 'Save'}
        </button>
      </div>
    </form>
  )
}

/** Links to other items: the chosen ones as chips, and a search to add more. */
function RelatedPicker({ selfId, value, candidates, onChange }: { selfId?: string | undefined; value: string[]; candidates: LinkCandidate[]; onChange: (ids: string[]) => void }) {
  const [query, setQuery] = useState('')
  const byId = new Map(candidates.map((c) => [c.id, c]))
  const chosen = value.filter((v) => byId.has(v))
  const q = query.trim().toLowerCase()
  const matches = q
    ? candidates.filter((c) => c.id !== selfId && !value.includes(c.id) && [c.name, c.username, c.url].some((x) => x?.toLowerCase().includes(q))).slice(0, 6)
    : []
  const add = (cid: string) => { onChange([...value, cid]); setQuery('') }
  return (
    <div className="field related-picker">
      <label htmlFor="f-related">Related items</label>
      {chosen.length ? (
        <ul className="related-chips" aria-label="Linked items">
          {chosen.map((cid) => (
            <li key={cid}>
              <Monogram name={byId.get(cid)!.name} url={byId.get(cid)!.url} size="sm" />
              <span>{byId.get(cid)!.name || 'Untitled'}</span>
              <button type="button" className="icon-btn" aria-label={`Unlink ${byId.get(cid)!.name}`} onClick={() => onChange(value.filter((v) => v !== cid))}><IconX size={13} /></button>
            </li>
          ))}
        </ul>
      ) : null}
      {chosen.length < RELATED_MAX ? (
        <div className="related-search">
          <input id="f-related" type="search" autoComplete="off" placeholder="Search items to link (a server and its SSH key, say)" value={query}
                 role="combobox" aria-expanded={matches.length > 0} aria-controls="f-related-list" aria-autocomplete="list"
                 onChange={(e) => setQuery(e.target.value)}
                 onKeyDown={(e) => { if (e.key === 'Enter' && matches[0]) { e.preventDefault(); add(matches[0].id) } }} />
          {matches.length ? (
            <ul id="f-related-list" className="related-matches" role="listbox">
              {matches.map((m) => (
                <li key={m.id} role="option" aria-selected={false}>
                  <button type="button" onClick={() => add(m.id)}>
                    <Monogram name={m.name} url={m.url} size="sm" />
                    <span className="tile-text"><span className="tile-name">{m.name || 'Untitled'}</span><span className="tile-meta">{m.username || m.url || typeSpec(m.type).label}</span></span>
                  </button>
                </li>
              ))}
            </ul>
          ) : q ? <p className="hint">No matching item.</p> : null}
        </div>
      ) : null}
    </div>
  )
}
