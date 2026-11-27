// One hosted company, run by the operator (admin console phase 4): its seats,
// suspend and resume, and the domains it verified. Vault contents and the
// company's own settings stay with the company.

import { useCallback, useEffect, useState } from 'react'

import { type AdminTenant, api } from '../../lib/api.js'
import * as session from '../../lib/session.js'
import { IconX } from '../../ui/icons.js'
import { CopyButton, useToast } from '../../ui/kit.js'
import { ErrorBox, run, when } from './common.js'

export function TenantPanel({ id, canWrite, onClose, onChanged }: { id: string; canWrite: boolean; onClose: () => void; onChanged: () => Promise<void> }) {
  const toast = useToast()
  const [t, setT] = useState<AdminTenant | null>(null)
  const [error, setError] = useState('')
  const [seats, setSeats] = useState('')
  const [domain, setDomain] = useState('')
  const load = useCallback(async () => {
    try {
      const d = await api.admin.tenant(await session.token(), id)
      setT(d); setSeats(d.seatLimit === null ? '' : String(d.seatLimit))
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not load.') }
  }, [id])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const act = async (fn: (tok: string) => Promise<unknown>, done: string) => { if (await run(toast, fn, done)) { await load(); await onChanged() } }

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="tenant-title" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div>
            <h2 id="tenant-title">{t?.hint || 'Company'}</h2>
            {t?.createdAt ? <p className="muted small">Created {when(t.createdAt)}</p> : null}
          </div>
          <button className="icon-btn" aria-label="Close" onClick={onClose}><IconX size={18} /></button>
        </div>
        <ErrorBox error={error} />
        {!t ? <div className="skeleton" /> : (
          <div className="drawer-body">
            <div className="pill-row">
              {t.suspended ? <span className="pill pill-danger">Suspended</span> : <span className="pill pill-ok">Active</span>}
              <span className="pill pill-plain">{t.seatLimit === null ? `${t.seatsUsed} seats used, no limit` : `${t.seatsUsed} of ${t.seatLimit} seats`}</span>
            </div>

            <h3>Seats</h3>
            <p className="muted small">Members and open invitations each take a seat. At the limit, the company can invite no one new until someone leaves or an invitation is withdrawn.</p>
            <form className="inline-form" onSubmit={(e) => {
              e.preventDefault()
              const n = seats.trim() === '' ? null : Number(seats)
              void act((tok) => api.admin.updateTenant(tok, id, { seatLimit: n }), n === null ? 'No seat limit' : `Seat limit set to ${n}`)
            }}>
              <input id="tenant-seats" type="number" min={1} max={100000} inputMode="numeric" placeholder="No limit" aria-label="Seat limit" disabled={!canWrite} value={seats} onChange={(e) => setSeats(e.target.value)} />
              <button className="btn btn-secondary btn-sm" type="submit" disabled={!canWrite}>Save</button>
            </form>

            <h3>Domains</h3>
            <p className="muted small">A verified domain is this company&apos;s. People who sign up with an address at it get their vault without waiting for approval, and are listed below to invite. Joining the company still needs an invitation and a fingerprint check.</p>
            {t.domains.length === 0 ? <p className="muted small">No domains yet.</p> : (
              <ul className="plain-list">
                {t.domains.map((d) => (
                  <li key={d.domain} className="domain-row">
                    <div><strong>{d.domain}</strong> {d.verifiedAt ? <span className="pill pill-ok">Verified</span> : <span className="pill pill-warn">Waiting for DNS</span>}</div>
                    {!d.verifiedAt ? (
                      <div className="dns-record">
                        <span className="muted small">Add this TXT record at the domain&apos;s DNS, then verify:</span>
                        <div className="recovery-key"><code>{d.record.name}  TXT  &quot;{d.record.value}&quot;</code><CopyButton value={d.record.value} label="TXT value" /></div>
                      </div>
                    ) : <span className="muted small">Verified {when(d.verifiedAt)}</span>}
                    {canWrite ? (
                      <div className="action-list">
                        {!d.verifiedAt ? <button className="btn btn-secondary btn-sm" onClick={() => void act((tok) => api.admin.verifyDomain(tok, id, d.domain), `${d.domain} is verified`)}>Verify</button> : null}
                        <button className="btn btn-secondary btn-sm" onClick={() => { if (window.confirm(`Let ${d.domain} go? Sign-ups at it will need approval again.`)) void act((tok) => api.admin.releaseDomain(tok, id, d.domain), `${d.domain} released`) }}>Remove</button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {canWrite ? (
              <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void act((tok) => api.admin.claimDomain(tok, id, domain), 'Domain added: add its DNS record').then(() => setDomain('')) }}>
                <input placeholder="acme.com" aria-label="Domain" value={domain} onChange={(e) => setDomain(e.target.value)} />
                <button className="btn btn-secondary btn-sm" type="submit" disabled={!domain.trim()}>Add domain</button>
              </form>
            ) : null}

            {t.atDomains.length ? <>
              <h3>At its domains, not in it yet</h3>
              <ul className="plain-list">{t.atDomains.map((a) => <li key={a.userId}>{a.email}</li>)}</ul>
              <p className="muted small">The company&apos;s admins invite them from People.</p>
            </> : null}

            {canWrite ? <>
              <h3 className="danger-title">Danger zone</h3>
              <div className="action-list">
                <button className={`btn btn-sm ${t.suspended ? 'btn-secondary' : 'btn-danger'}`} onClick={() => {
                  if (t.suspended || window.confirm(`Suspend ${t.hint || 'this company'}? Its members keep their own vaults but cannot open the company's collections, and it takes no one new, until you resume it. The other owners and admins are told.`)) {
                    void act((tok) => api.admin.updateTenant(tok, id, { suspended: !t.suspended }), t.suspended ? 'Company resumed' : 'Company suspended')
                  }
                }}>{t.suspended ? 'Resume company' : 'Suspend company'}</button>
              </div>
            </> : null}
          </div>
        )}
      </aside>
    </div>
  )
}
