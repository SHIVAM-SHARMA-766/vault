// Making a share link for one item (D3): choose how long and how many
// views, get a link to send. The key is in the link; the server never sees it.

import { useState } from 'react'

import type { EntryContent } from '@vault/crypto'

import { api } from '../../lib/api.js'
import { linkFor, sealShare, toShared } from '../../lib/share.js'
import * as session from '../../lib/session.js'
import { IconAlert } from '../../ui/icons.js'
import { CopyButton } from '../../ui/kit.js'

const EXPIRY = [[3600, '1 hour'], [86_400, '1 day'], [7 * 86_400, '7 days'], [30 * 86_400, '30 days']] as const
const VIEWS = [[1, 'Once'], [2, '2 times'], [5, '5 times'], [10, '10 times'], [null, 'No limit']] as const

export function ShareLinkDialog({ entry, vaultKey, onClose }: { entry: EntryContent; vaultKey: Uint8Array; onClose: () => void }) {
  const [expiresIn, setExpiresIn] = useState<number>(86_400)
  const [maxViews, setMaxViews] = useState<number | null>(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null)

  async function create(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      const sealed = await sealShare(toShared(entry), vaultKey)
      const res = await api.shares.create(await session.token(), { id: sealed.id, blob: sealed.blob, labelBlob: sealed.labelBlob, expiresIn, maxViews })
      setLink({ url: linkFor(sealed.id, sealed.key), expiresAt: res.expiresAt })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the link.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="sl-title" onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
      <form className="modal" onSubmit={create}>
        <h2 id="sl-title">Share “{entry.name || 'Untitled'}” by link</h2>
        {link ? (
          <>
            <p className="muted">Anyone with this link can open the item, until {new Date(link.expiresAt).toLocaleString()}{maxViews ? `, ${maxViews === 1 ? 'once' : `${maxViews} times`}` : ''}. Send it over a channel you trust.</p>
            <div className="share-link">
              <input readOnly aria-label="Share link" value={link.url} onFocus={(e) => e.currentTarget.select()} className="mono" />
              <CopyButton value={link.url} label="link" />
            </div>
            <p className="muted small">The key is the part after #. Vault never receives it, so it cannot show you this link again — copy it now. You can revoke it in Settings → Security.</p>
            <div className="modal-actions"><button type="button" className="btn btn-primary" onClick={onClose}>Done</button></div>
          </>
        ) : (
          <>
            <p className="muted">Makes an encrypted copy of this item that opens without an account. Later edits to the item are not in the copy.</p>
            <div className="grid-2">
              <div className="field">
                <label htmlFor="sl-expiry">Expires after</label>
                <select id="sl-expiry" value={expiresIn} onChange={(e) => setExpiresIn(Number(e.target.value))}>
                  {EXPIRY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="sl-views">Can be opened</label>
                <select id="sl-views" value={maxViews ?? ''} onChange={(e) => setMaxViews(e.target.value === '' ? null : Number(e.target.value))}>
                  {VIEWS.map(([v, l]) => <option key={l} value={v ?? ''}>{l}</option>)}
                </select>
              </div>
            </div>
            {error ? <p className="alert alert-error"><IconAlert size={16} />{error}</p> : null}
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? <span className="spinner" /> : null}Create link</button>
            </div>
          </>
        )}
      </form>
    </div>
  )
}
