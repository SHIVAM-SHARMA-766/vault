// The share links this account made (D3): what each opens, how often it was
// opened, and a way to stop it.

import { useEffect, useState } from 'react'

import { type ShareRow, api } from '../../lib/api.js'
import { openLabel } from '../../lib/share.js'
import * as session from '../../lib/session.js'
import { IconLink } from '../../ui/icons.js'
import { useToast } from '../../ui/kit.js'
import { when } from '../../lib/format.js'

const STATUS: Record<ShareRow['status'], [string, string]> = {
  live: ['Live', 'pill-ok'], used: ['Used up', ''], expired: ['Expired', ''], revoked: ['Revoked', 'pill-danger'],
}

export function ShareLinks({ vaultKey }: { vaultKey: Uint8Array }) {
  const toast = useToast()
  const [rows, setRows] = useState<(ShareRow & { name: string })[] | null>(null)

  async function load() {
    try {
      const { shares } = await api.shares.list(await session.token())
      setRows(await Promise.all(shares.map(async (s) => ({ ...s, name: await openLabel(s.id, s.labelBlob, vaultKey) }))))
    } catch { setRows([]) }
  }
  useEffect(() => { void load() }, [vaultKey])

  async function revoke(row: ShareRow & { name: string }) {
    try { await api.shares.revoke(await session.token(), row.id); toast(`Link to ${row.name} revoked`); await load() }
    catch (err) { toast(err instanceof Error ? err.message : 'Could not revoke it.', 'error') }
  }

  return (
    <section className="settings-card" aria-labelledby="s-links">
      <div className="settings-card-head"><IconLink size={18} /><h2 id="s-links">Share links</h2></div>
      <p className="muted small">Links you made with <strong>Link</strong> on an item. Each opens an encrypted copy without an account. Opening one appears in your activity below.</p>
      {rows === null ? <p className="muted small">Loading…</p> : rows.length === 0 ? <p className="muted small">No links yet.</p> : (
        <ul className="device-list">
          {rows.map((r) => {
            const [label, cls] = STATUS[r.status]
            return (
              <li key={r.id} className="device-row">
                <div className="device-text">
                  <span className="device-name">{r.name}<span className={`pill ${cls}`}>{label}</span></span>
                  <span className="muted small">
                    Opened {r.views}{r.maxViews ? ` of ${r.maxViews}` : ''} {r.views === 1 && !r.maxViews ? 'time' : 'times'} · made {when(r.createdAt)} · {r.status === 'live' ? 'expires' : 'expired'} {when(r.expiresAt)}
                  </span>
                </div>
                {r.status === 'live' ? <div className="device-actions"><button className="btn btn-danger-ghost btn-sm" onClick={() => void revoke(r)} aria-label={`Revoke link to ${r.name}`}>Revoke</button></div> : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
