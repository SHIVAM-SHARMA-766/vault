// Opening a share link (D3), with no account. The page loads without
// spending a view — a chat app's link preview fetches only this — and the
// copy is fetched and opened in this browser when the person asks.

import { useState } from 'react'

import { readField, typeSpec } from '@vault/core'

import { ApiError, api } from '../../lib/api.js'
import { type SharedItem, openShareBlob, parseLink } from '../../lib/share.js'
import { IconAlert, IconLock, IconShield } from '../../ui/icons.js'
import { typeInfo } from '../../ui/kit.js'
import { FieldView, SecretRow, TextRow } from '../vault/fields.js'

export function ShareView() {
  const link = parseLink(location.pathname, location.hash)
  const [state, setState] = useState<{ item: SharedItem; sharedAt: string; viewsLeft: number | null; expiresAt: string } | null>(null)
  const [error, setError] = useState(link ? '' : 'This link is incomplete. Ask for it to be sent again, whole — including the part after #.')
  const [busy, setBusy] = useState(false)

  async function open() {
    if (!link) return
    setBusy(true); setError('')
    try {
      const res = await api.shares.open(link.id)
      const opened = await openShareBlob(link.id, link.key, res.blob)
      setState({ ...opened, viewsLeft: res.viewsLeft, expiresAt: res.expiresAt })
      // The key has done its job; keep it out of history and screenshots of the address bar.
      history.replaceState(null, '', location.pathname)
    } catch (err) {
      setError(err instanceof ApiError && err.status === 404 ? 'This link has expired, was used up, or was revoked.'
        : err instanceof ApiError ? err.message : 'This link could not be opened. It may have been changed or cut short.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth share-page">
      <main className="auth-main">
      <div className="auth-card share-card">
        <a className="brand" href="/" title="Go to the Vault website"><span className="brand-mark"><IconShield size={20} /></span>Vault</a>
        {state ? <Shared {...state} /> : (
          <>
            <h1 className="auth-title">Someone shared an item with you</h1>
            <p className="auth-sub">It is encrypted, and opens only in this browser with the key in your link. Opening it may use up the link.</p>
            {error ? <p className="alert alert-error"><IconAlert size={16} />{error}</p> : null}
            {link ? <button className="btn btn-primary btn-block" onClick={() => void open()} disabled={busy}>{busy ? <span className="spinner" /> : <IconLock size={16} />}Open it</button> : null}
          </>
        )}
      </div>
      </main>
    </div>
  )
}

function Shared({ item, sharedAt, viewsLeft, expiresAt }: { item: SharedItem; sharedAt: string; viewsLeft: number | null; expiresAt: string }) {
  const spec = typeSpec(item.type)
  const info = typeInfo(item.type)
  const entry = { ...item, tags: [], favorite: false, customFields: item.customFields ?? [] }
  return (
    <>
      <h1 className="auth-title">{item.name || 'Untitled'}</h1>
      <p className="muted small"><span className="badge"><info.Icon size={13} />{info.label}</span> Shared {new Date(sharedAt).toLocaleString()}</p>
      <div className="fields">
        {spec.fields.map((f) => <FieldView key={f.key} spec={f} value={readField(entry, f)} entryType={item.type} />)}
        {entry.customFields.map((c, i) => c.hidden
          ? <SecretRow key={i} label={c.label || 'Hidden field'} value={c.value} />
          : <TextRow key={i} label={c.label || 'Field'} value={c.value} />)}
      </div>
      {item.notes ? <div className="notes"><span className="field-label">Notes</span><pre>{item.notes}</pre></div> : null}
      <p className="alert alert-warn"><IconAlert size={16} /><span>
        {viewsLeft === 0 ? 'This was the last view: the link no longer works. Save what you need now.'
          : `The link works until ${new Date(expiresAt).toLocaleString()}${viewsLeft !== null ? ` for ${viewsLeft} more ${viewsLeft === 1 ? 'view' : 'views'}` : ''}.`}
      </span></p>
    </>
  )
}
