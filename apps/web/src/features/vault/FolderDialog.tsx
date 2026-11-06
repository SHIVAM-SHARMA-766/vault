// Naming a folder: new, new inside another, or renamed.

import { useState } from 'react'

import { IconAlert } from '../../ui/icons.js'

export function FolderDialog({ title, initial = '', parentPath, onCancel, onSave }: {
  title: string
  initial?: string
  parentPath?: string
  onCancel: () => void
  onSave: (name: string) => Promise<void>
}) {
  const [name, setName] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="fd-title"
         onKeyDown={(e) => { if (e.key === 'Escape') onCancel() }}>
      <form className="modal" onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        try { await onSave(name.trim()) } catch (err) { setError(err instanceof Error ? err.message : 'Could not save.'); setBusy(false) }
      }}>
        <h2 id="fd-title">{title}</h2>
        {parentPath ? <p className="muted">Inside <strong>{parentPath}</strong></p> : null}
        <label htmlFor="fd-name" className="field-label">Folder name</label>
        <input id="fd-name" autoFocus maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        {error ? <p className="alert alert-error"><IconAlert size={16} />{error}</p> : null}
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>{busy ? <span className="spinner" /> : null}Save</button>
        </div>
      </form>
    </div>
  )
}
