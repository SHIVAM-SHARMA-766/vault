// The website editor. The form is drawn from the schema the server sends, so a
// field added to apps/site/content/schema.json appears here without a client
// change, and the limits shown are the limits the server enforces.
//
// Edits are a draft until published. Publishing renders the site on the
// server and swaps it in; every published version is kept and can be put back.

import { useCallback, useEffect, useMemo, useState } from 'react'

import { validateContent } from '@vault/site/content'
import { ICONS } from '@vault/site/render'

import {
  ApiError,
  type SiteContent,
  type SiteField,
  type SiteMedia,
  type SiteState,
  api,
} from '../../lib/api.js'
import * as session from '../../lib/session.js'
import {
  IconAlert, IconCheck, IconDown, IconExternal, IconImage, IconNote, IconPlus, IconRefresh, IconTrash, IconUp, IconX,
} from '../../ui/icons.js'
import { useToast } from '../../ui/kit.js'
import { Link } from '../../lib/router.js'

const PAGE_OF: Record<string, string> = {
  global: 'index.html', home: 'index.html', features: 'features.html', how: 'how-it-works.html',
  faq: 'faq.html', about: 'about.html', security: 'security.html',
}
const MEDIA_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }
const mediaUrl = (m: SiteMedia) => `/media/${m.id}.${MEDIA_EXT[m.type] ?? 'png'}`

type View = { kind: 'section'; id: string } | { kind: 'images' } | { kind: 'history' }

function when(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function setAt(obj: SiteContent, path: (string | number)[], value: unknown): SiteContent {
  const copy = structuredClone(obj) as unknown as Record<string, unknown>
  let cur: Record<string | number, unknown> = copy
  for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]!] as Record<string | number, unknown>
  cur[path[path.length - 1]!] = value
  return copy as unknown as SiteContent
}

export function Website({ canWrite, canPublish }: { canWrite: boolean; canPublish: boolean }) {
  const toast = useToast()
  const [state, setState] = useState<SiteState | null>(null)
  const [content, setContent] = useState<SiteContent | null>(null)
  const [saved, setSaved] = useState<string>('')
  const [view, setView] = useState<View>({ kind: 'section', id: 'home' })
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [note, setNote] = useState('')
  const [loadError, setLoadError] = useState('')

  /** Reloads from the server. `keepEdits` refreshes everything except the
   *  form, so uploading an image or restoring a version does not throw away
   *  changes that have not been saved yet. */
  const load = useCallback(async (keepEdits = false) => {
    setLoadError('')
    try {
      const s = await api.admin.site(await session.token())
      setState(s)
      if (!keepEdits) {
        const c = s.draft?.content ?? s.live.content
        setContent(c)
        setSaved(JSON.stringify(c))
        setServerErrors({})
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load the website.')
    }
  }, [])
  useEffect(() => { void load() }, [load])
  const refreshKeepingEdits = useCallback(() => load(true), [load])

  const mediaIds = useMemo(() => new Set((state?.media ?? []).map((m) => m.id)), [state])
  const localErrors = useMemo(() => {
    if (!state || !content) return {}
    const { errors } = validateContent(state.schema, content, state.defaults, mediaIds)
    return Object.fromEntries(errors.map((e) => [e.path, e.message]))
  }, [state, content, mediaIds])
  const errors = { ...localErrors, ...serverErrors }
  const dirty = content !== null && JSON.stringify(content) !== saved
  const hasDraft = Boolean(state?.draft) || dirty
  const errorCount = Object.keys(errors).length

  if (loadError) return <section className="admin-section"><p className="alert alert-error"><IconAlert size={16} />{loadError}</p></section>
  if (!state || !content) return <section className="admin-section"><div className="skeletons">{[0, 1, 2].map((i) => <div key={i} className="skeleton" />)}</div></section>

  const update = (path: (string | number)[], value: unknown) => {
    setContent((c) => (c ? setAt(c, path, value) : c))
    setServerErrors({})
  }

  async function saveDraft(): Promise<boolean> {
    if (!content) return false
    setBusy('save')
    try {
      const res = await api.admin.saveDraft(await session.token(), content)
      setContent(res.content)
      setSaved(JSON.stringify(res.content))
      setState((s) => (s ? { ...s, draft: { content: res.content, updatedAt: new Date().toISOString(), updatedBy: null } } : s))
      toast('Draft saved')
      return true
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) showDetails(err)
      toast(err instanceof Error ? err.message : 'Could not save.', 'error')
      return false
    } finally {
      setBusy('')
    }
  }

  function showDetails(err: ApiError) {
    const details = err.details
    if (details) setServerErrors(Object.fromEntries(details.map((d) => [d.path, d.message])))
  }

  async function preview() {
    if (!content) return
    // Opened first, inside the click, so a popup blocker allows it.
    const win = window.open('', '_blank')
    try {
      const page = view.kind === 'section' ? PAGE_OF[view.id] ?? 'index.html' : 'index.html'
      const { html } = await api.admin.preview(await session.token(), content, page)
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
      if (win) win.location.href = url
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (err) {
      win?.close()
      if (err instanceof ApiError && err.status === 400) showDetails(err)
      toast(err instanceof Error ? err.message : 'Could not build the preview.', 'error')
    }
  }

  async function publish() {
    if (dirty && !(await saveDraft())) return
    setBusy('publish')
    try {
      const res = await api.admin.publish(await session.token(), note)
      toast(`Published — live now (${res.version.slice(0, 8)})`)
      setPublishing(false)
      setNote('')
      await load()
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) showDetails(err)
      toast(err instanceof Error ? err.message : 'Could not publish.', 'error')
    } finally {
      setBusy('')
    }
  }

  async function discard() {
    setBusy('discard')
    try {
      if (state?.draft) await api.admin.discardDraft(await session.token())
      await load()
      toast('Draft discarded; showing the live site')
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not discard.', 'error')
    } finally {
      setBusy('')
    }
  }

  const section = view.kind === 'section' ? state.schema.sections.find((s) => s.id === view.id) : undefined

  return (
    <section className="admin-section site-editor">
      <div className="admin-head">
        <div>
          <ol className="crumbs crumbs-admin" aria-label="Breadcrumb">
            <li><Link to="/app/">Vault</Link></li>
            <li>Admin</li>
            <li aria-current="page">Website{view.kind === 'section' ? ` · ${state.schema.sections.find((s) => s.id === view.id)?.label ?? ''}` : view.kind === 'images' ? ' · Images' : ' · History'}</li>
          </ol>
          <h1>Website</h1>
          <p className="muted">
            {state.live.version
              ? <>Live version published {when(state.live.publishedAt)}.</>
              : <>The site is showing its built-in text. Nothing has been published from here yet.</>}
            {' '}{hasDraft ? <span className="pill pill-accent">Unpublished changes</span> : null}
          </p>
        </div>
        <div className="admin-actions">
          <button className="btn btn-secondary btn-sm" onClick={() => void preview()} disabled={errorCount > 0}><IconExternal size={15} />Preview</button>
          {canWrite ? (
            <>
              {hasDraft ? <button className="btn btn-ghost btn-sm" onClick={() => void discard()} disabled={busy !== ''}>Discard</button> : null}
              <button className="btn btn-secondary btn-sm" onClick={() => void saveDraft()} disabled={!dirty || busy !== '' || errorCount > 0}>
                {busy === 'save' ? <span className="spinner" /> : <IconCheck size={15} />}Save draft
              </button>
            </>
          ) : null}
          {canPublish ? (
            <button className="btn btn-primary btn-sm" onClick={() => setPublishing(true)} disabled={!hasDraft || errorCount > 0 || busy !== ''}>Publish</button>
          ) : null}
        </div>
      </div>

      {!canWrite ? <p className="alert alert-warn"><IconAlert size={16} /><span>You can look, but not change anything. Your role is read-only.</span></p> : null}
      {errorCount > 0 ? (
        <p className="alert alert-error"><IconAlert size={16} /><span>{errorCount} field(s) need attention before this can be saved or published. They are marked below.</span></p>
      ) : null}

      <div className="site-layout">
        <nav className="site-nav" aria-label="Website sections">
          <span className="site-nav-heading">Pages</span>
          {state.schema.sections.map((s) => {
            const bad = Object.keys(errors).some((p) => p.startsWith(`${s.id}.`))
            return (
              <button key={s.id} className={`side-item ${view.kind === 'section' && view.id === s.id ? 'side-active' : ''}`}
                      onClick={() => setView({ kind: 'section', id: s.id })}>
                <span>{s.label}</span>{bad ? <span className="dot dot-warn" /> : null}
              </button>
            )
          })}
          <span className="site-nav-heading">Library</span>
          <button className={`side-item ${view.kind === 'images' ? 'side-active' : ''}`} onClick={() => setView({ kind: 'images' })}>
            <IconImage size={15} /><span>Images</span><span className="side-count">{state.media.length}</span>
          </button>
          <button className={`side-item ${view.kind === 'history' ? 'side-active' : ''}`} onClick={() => setView({ kind: 'history' })}>
            <IconNote size={15} /><span>History</span><span className="side-count">{state.versions.length}</span>
          </button>
        </nav>

        <div className="site-body">
          {section ? (
            <>
              {section.hint ? <p className="muted small site-hint">{section.hint}</p> : null}
              {section.groups.map((g) => (
                <div key={g.key} className="admin-card site-group">
                  <div className="site-group-head">
                    <h2>{g.label}</h2>
                    {g.hint ? <p className="muted small">{g.hint}</p> : null}
                  </div>
                  {g.fields.map((f) => (
                    <FieldEditor key={f.key} field={f} path={[section.id, g.key, f.key]}
                                 value={content[section.id]?.[g.key]?.[f.key]} errors={errors}
                                 media={state.media} disabled={!canWrite} onChange={update} />
                  ))}
                </div>
              ))}
            </>
          ) : view.kind === 'images' ? (
            <Images media={state.media} canWrite={canWrite} onChanged={refreshKeepingEdits} />
          ) : (
            <History state={state} canPublish={canPublish} onChanged={refreshKeepingEdits} />
          )}
        </div>
      </div>

      {publishing ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="pub-title">
          <div className="modal">
            <h2 id="pub-title">Publish to the live site?</h2>
            <p className="muted">Visitors see the change immediately. The current version stays in History and can be put back in one click.</p>
            <label htmlFor="pub-note" className="field-label">What changed (optional)</label>
            <input id="pub-note" maxLength={140} placeholder="e.g. New homepage headline" value={note} onChange={(e) => setNote(e.target.value)} />
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setPublishing(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={() => void publish()} disabled={busy !== ''}>
                {busy === 'publish' ? <><span className="spinner" />Publishing…</> : 'Publish now'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}

// ── Fields ────────────────────────────────────────────────────────────────

function FieldEditor({ field, path, value, errors, media, disabled, onChange }: {
  field: SiteField
  path: (string | number)[]
  value: unknown
  errors: Record<string, string>
  media: SiteMedia[]
  disabled: boolean
  onChange: (path: (string | number)[], value: unknown) => void
}) {
  const id = `f-${path.join('-')}`
  const error = errors[path.join('.')]
  const label = (
    <div className="label-row">
      <label htmlFor={id}>{field.label}</label>
      {field.max && typeof value === 'string' ? (
        <span className={`counter ${value.length > field.max ? 'counter-over' : ''}`}>{value.length}/{field.max}</span>
      ) : null}
    </div>
  )
  const foot = (
    <>
      {error ? <p className="hint hint-error">{error}</p> : field.hint ? <p className="hint">{field.hint}</p> : null}
    </>
  )

  switch (field.type) {
    case 'text':
    case 'link':
      return (
        <div className={`field ${error ? 'field-error' : ''}`}>
          {label}
          <input id={id} value={String(value ?? '')} disabled={disabled} placeholder={field.type === 'link' ? '/features or https://…' : ''}
                 onChange={(e) => onChange(path, e.target.value)} />
          {foot}
        </div>
      )
    case 'textarea':
      return (
        <div className={`field ${error ? 'field-error' : ''}`}>
          {label}
          <textarea id={id} rows={Math.min(8, Math.max(3, Math.ceil((field.max ?? 200) / 120)))} value={String(value ?? '')}
                    disabled={disabled} onChange={(e) => onChange(path, e.target.value)} />
          {foot}
        </div>
      )
    case 'bool':
      return (
        <div className="field">
          <label className="switch">
            <input type="checkbox" checked={Boolean(value)} disabled={disabled} onChange={(e) => onChange(path, e.target.checked)} />
            <span className="switch-track" aria-hidden="true" />
            <span>{field.label}</span>
          </label>
        </div>
      )
    case 'select':
      return (
        <div className={`field ${error ? 'field-error' : ''}`}>
          {label}
          <select id={id} value={String(value ?? '')} disabled={disabled} onChange={(e) => onChange(path, e.target.value)}>
            {(field.options ?? []).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          {foot}
        </div>
      )
    case 'icon':
      return (
        <div className="field field-narrow">
          {label}
          <select id={id} value={String(value ?? '')} disabled={disabled} onChange={(e) => onChange(path, e.target.value)}>
            {ICONS.filter((n) => n !== 'arrow').map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      )
    case 'image': {
      const chosen = media.find((m) => m.id === value)
      return (
        <div className={`field ${error ? 'field-error' : ''}`}>
          {label}
          <div className="image-field">
            <img src={chosen ? mediaUrl(chosen) : field.fallback ?? '/img/vault.png'} alt="" />
            <div className="image-field-side">
              <select id={id} value={String(value ?? '')} disabled={disabled} onChange={(e) => onChange(path, e.target.value || null)}>
                <option value="">Built-in image</option>
                {media.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
              <p className="hint">Upload new images under Library → Images, then choose them here.</p>
            </div>
          </div>
          {error ? <p className="hint hint-error">{error}</p> : null}
        </div>
      )
    }
    case 'list': {
      const items = Array.isArray(value) ? (value as Record<string, unknown>[]) : []
      const min = field.min ?? 0
      const max = field.max ?? 50
      const blank = () => Object.fromEntries((field.fields ?? []).map((f) => [f.key,
        f.type === 'bool' ? false : f.type === 'select' ? f.options?.[0]?.[0] : f.type === 'icon' ? 'shield' : f.type === 'image' ? null : '']))
      const move = (from: number, to: number) => {
        const next = [...items]
        const [it] = next.splice(from, 1)
        next.splice(to, 0, it!)
        onChange(path, next)
      }
      return (
        <div className={`field list-field ${error ? 'field-error' : ''}`}>
          <div className="label-row"><label>{field.label}</label><span className="counter">{items.length} of {min === max ? max : `${min}–${max}`}</span></div>
          {error ? <p className="hint hint-error">{error}</p> : null}
          {items.map((item, i) => (
            <div key={i} className="list-item">
              <div className="list-item-head">
                <span className="list-item-title">{field.itemLabel ?? 'Item'} {i + 1}</span>
                {!disabled ? (
                  <span className="row-actions">
                    <button type="button" className="icon-btn" aria-label="Move up" disabled={i === 0} onClick={() => move(i, i - 1)}><IconUp size={15} /></button>
                    <button type="button" className="icon-btn" aria-label="Move down" disabled={i === items.length - 1} onClick={() => move(i, i + 1)}><IconDown size={15} /></button>
                    <button type="button" className="icon-btn icon-danger" aria-label="Remove" disabled={items.length <= min}
                            onClick={() => onChange(path, items.filter((_, j) => j !== i))}><IconX size={15} /></button>
                  </span>
                ) : null}
              </div>
              <div className="list-item-fields">
                {(field.fields ?? []).map((f) => (
                  <FieldEditor key={f.key} field={f} path={[...path, i, f.key]} value={item[f.key]} errors={errors}
                               media={media} disabled={disabled} onChange={onChange} />
                ))}
              </div>
            </div>
          ))}
          {!disabled && items.length < max ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => onChange(path, [...items, blank()])}>
              <IconPlus size={15} />Add {(field.itemLabel ?? 'item').toLowerCase()}
            </button>
          ) : null}
        </div>
      )
    }
  }
}

// ── Images ────────────────────────────────────────────────────────────────

function Images({ media, canWrite, onChanged }: { media: SiteMedia[]; canWrite: boolean; onChanged: () => Promise<void> }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  async function upload(file: File) {
    if (file.size > 2 * 1024 * 1024) { toast('Images are limited to 2 MB.', 'error'); return }
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { toast('Use a PNG, JPEG or WebP image.', 'error'); return }
    setBusy(true)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      let bin = ''
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      await api.admin.uploadMedia(await session.token(), file.name, btoa(bin))
      toast('Image uploaded')
      await onChanged()
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not upload.', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="admin-card site-group">
        <div className="site-group-head">
          <h2>Images</h2>
          <p className="muted small">PNG, JPEG or WebP, up to 2 MB. SVG is not accepted on this site. Uploaded images can be chosen in any image field; an image in use cannot be deleted.</p>
        </div>
        {canWrite ? (
          <label className={`upload ${busy ? 'upload-busy' : ''}`}>
            <input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy}
                   onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = '' }} />
            {busy ? <><span className="spinner" />Uploading…</> : <><IconPlus size={16} />Upload an image</>}
          </label>
        ) : null}
      </div>
      {media.length === 0 ? <p className="muted">No images uploaded yet. The site uses its built-in images.</p> : (
        <div className="media-grid">
          {media.map((m) => (
            <figure key={m.id} className="media-card">
              <img src={mediaUrl(m)} alt="" loading="lazy" />
              <figcaption>
                <span className="media-name" title={m.name}>{m.name}</span>
                <span className="muted small">{(m.bytes / 1024).toFixed(0)} KB · {when(m.uploadedAt)}</span>
              </figcaption>
              {canWrite ? (
                <button className="icon-btn icon-danger media-del" aria-label={`Delete ${m.name}`}
                        onClick={async () => {
                          try { await api.admin.deleteMedia(await session.token(), m.id); toast('Image deleted'); await onChanged() }
                          catch (err) { toast(err instanceof Error ? err.message : 'Could not delete.', 'error') }
                        }}>
                  <IconTrash size={15} />
                </button>
              ) : null}
            </figure>
          ))}
        </div>
      )}
    </div>
  )
}

// ── History ───────────────────────────────────────────────────────────────

function History({ state, canPublish, onChanged }: { state: SiteState; canPublish: boolean; onChanged: () => Promise<void> }) {
  const toast = useToast()
  return (
    <div className="admin-card site-group">
      <div className="site-group-head">
        <h2>Published versions</h2>
        <p className="muted small">The last 30 are kept. Putting one back makes it live immediately and does not touch the draft.</p>
      </div>
      {state.versions.length === 0 ? <p className="muted">Nothing published from here yet.</p> : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Published</th><th>Note</th><th>Status</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {state.versions.map((v) => (
                <tr key={v.version}>
                  <td>{when(v.publishedAt)}</td>
                  <td className="strong">{v.note ?? '—'}</td>
                  <td>{v.version === state.live.version ? <span className="pill pill-ok">Live</span> : null}</td>
                  <td>
                    {canPublish && v.version !== state.live.version ? (
                      <button className="btn btn-secondary btn-sm"
                              onClick={async () => {
                                try { await api.admin.rollback(await session.token(), v.version); toast('That version is live again'); await onChanged() }
                                catch (err) { toast(err instanceof Error ? err.message : 'Could not put it back.', 'error') }
                              }}>
                        <IconRefresh size={14} />Make live
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
