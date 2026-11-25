// Team password health (decisions/0032, 2c): weak, reused, old, breached and
// exposed passwords across the collections an admin manages, computed in the
// admin's browser exactly as the personal health check is. The server sees no
// password and no score. The report lists items, not people.

import { useMemo, useState } from 'react'

import { ISSUES, type Issue, PASSWORD_ISSUES, analyse } from '@vault/core'

import { checkBreaches } from '../../lib/breach.js'
import { when } from '../../lib/format.js'
import { useInstance } from '../../lib/instance.js'
import { IconAlert, IconCheck, IconPulse } from '../../ui/icons.js'
import { useToast } from '../../ui/kit.js'
import type { OrgView, Teams } from '../orgs/model.js'

export function TeamHealth({ org, teams }: { org: OrgView; teams: Teams }) {
  const toast = useToast()
  const instance = useInstance()
  const [breaches, setBreaches] = useState<Map<string, number> | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [filter, setFilter] = useState<Issue | 'all'>('all')

  // The collections this admin manages, and what is in them.
  const managed = teams.collections.filter((c) => c.orgId === org.id && c.key && c.permission === 'manage')
  const unmanaged = teams.collections.filter((c) => c.orgId === org.id && !(c.key && c.permission === 'manage')).length
  const items = teams.shared.filter((e) => e.orgId === org.id && managed.some((c) => c.id === e.collectionId) && !e.archived)
  const where = (id: string) => managed.find((c) => c.id === id)?.name ?? ''

  const report = useMemo(() => {
    const exposed = new Set(items.filter((e) => e.exposed).map((e) => e.id))
    const hit = new Set(breaches ? items.filter((e) => e.password && (breaches.get(e.password) ?? 0) > 0).map((e) => e.id) : [])
    return analyse(items.map((e) => ({ ...e, updatedAt: e.updatedAt ?? new Date(0).toISOString() })), Date.now(), hit, exposed)
  }, [items, breaches])

  const perCollection = managed.map((c) => {
    const inside = items.filter((e) => e.collectionId === c.id)
    const failing = inside.filter((e) => (report.issues.get(e.id) ?? []).some((i) => PASSWORD_ISSUES.includes(i))).length
    return { c, total: inside.length, failing }
  })
  const flagged = items.filter((e) => (report.issues.get(e.id) ?? []).length > 0)
    .filter((e) => filter === 'all' || (report.issues.get(e.id) ?? []).includes(filter))
    .sort((a, b) => (report.issues.get(b.id)?.length ?? 0) - (report.issues.get(a.id)?.length ?? 0) || a.name.localeCompare(b.name))

  async function runBreachCheck() {
    const passwords = [...new Set(items.map((e) => e.password).filter((p): p is string => !!p))]
    try { setBreaches(await checkBreaches(passwords, (done, total) => setProgress(`Checking… ${done} of ${total}`))) }
    catch (err) { toast(err instanceof Error ? err.message : 'The breach check failed.', 'error') }
    finally { setProgress(null) }
  }

  return (
    <section className="settings-card org-card team-health" aria-label={org.name}>
      <div className="settings-card-head"><IconPulse size={18} /><h2>{org.name}</h2>
        <span className="muted small">{report.checked} password{report.checked === 1 ? '' : 's'} in {managed.length} collection{managed.length === 1 ? '' : 's'} you manage</span></div>

      {managed.length === 0 ? <p className="muted small">You manage no collections here, so there is nothing to check.</p> : (
        <>
          <div className="health-summary">
            <div className={`health-score ${report.score >= 80 ? 'is-ok' : report.score >= 50 ? 'is-warn' : 'is-bad'}`} aria-label={`Score ${report.score} out of 100`}>
              <strong>{report.score}</strong><span className="muted small">of 100</span>
            </div>
            <div className="health-counts">
              {PASSWORD_ISSUES.filter((i) => report.counts[i] > 0).map((i) => (
                <button key={i} className={`chip ${filter === i ? 'chip-active' : ''}`} onClick={() => setFilter(filter === i ? 'all' : i)}>
                  {ISSUES.find((x) => x.issue === i)!.label} <span className="count">{report.counts[i]}</span>
                </button>
              ))}
              {report.failing === 0 ? <p className="small health-ok"><IconCheck size={14} /> No password needs attention.</p> : null}
            </div>
          </div>

          {instance?.breachCheck && report.checked ? (
            <p className="small breach-line">
              {progress ? <span role="status">{progress}</span>
                : breaches ? <span role="status">{report.counts.breached ? `${report.counts.breached} ${report.counts.breached === 1 ? 'password was' : 'passwords were'} found in known breaches.` : 'No password was found in known breaches.'}</span>
                : <button className="btn btn-secondary btn-sm" onClick={() => void runBreachCheck()}>Check for breaches</button>}
            </p>
          ) : null}

          <h3 className="small-head">By collection</h3>
          <ul className="device-list">
            {perCollection.map(({ c, total, failing }) => (
              <li key={c.id} className="device-row health-collection">
                <span className="device-name">{c.name}</span>
                <span className={`small ${failing ? 'fact-warn' : 'fact-ok'}`}>{failing ? `${failing} of ${total} need attention` : `${total} item${total === 1 ? '' : 's'}, all fine`}</span>
              </li>
            ))}
          </ul>

          {flagged.length ? (
            <>
              <h3 className="small-head">{filter === 'all' ? 'Items to fix' : ISSUES.find((x) => x.issue === filter)!.label}</h3>
              <ul className="device-list">
                {flagged.map((e) => (
                  <li key={e.id} className="device-row health-item">
                    <div className="device-text">
                      <span className="device-name">{e.name}</span>
                      <span className="muted small">{where(e.collectionId)}{e.passwordChangedAt ? ` · changed ${when(e.passwordChangedAt)}` : ''}</span>
                    </div>
                    <span className="health-issues">
                      {(report.issues.get(e.id) ?? []).map((i) => <span key={i} className={`pill ${PASSWORD_ISSUES.includes(i) ? 'pill-danger' : ''}`} title={ISSUES.find((x) => x.issue === i)!.advice}>{ISSUES.find((x) => x.issue === i)!.label}</span>)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <p className="hint">Worked out in this browser from the collections you manage; the server never sees a password or a score.
            {unmanaged ? ` ${unmanaged} collection${unmanaged === 1 ? '' : 's'} you do not manage ${unmanaged === 1 ? 'is' : 'are'} left out.` : ''}
            {' '}Fix an item from your vault, under <strong>Shared</strong>.</p>
          {report.counts.exposed ? <p className="alert alert-warn"><IconAlert size={16} /><span>Someone who could open {report.counts.exposed === 1 ? 'one of these' : 'some of these'} has left. Change {report.counts.exposed === 1 ? 'that password' : 'those passwords'} at the site, then here.</span></p> : null}
        </>
      )}
    </section>
  )
}
