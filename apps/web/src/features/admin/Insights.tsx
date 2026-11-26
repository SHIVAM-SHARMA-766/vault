// The security dashboard and reports (admin console phase 2): what needs
// attention, sign-ins over 30 days, and reports to read or download.

import { useEffect, useMemo, useRef, useState } from 'react'

import { type AdminInsights, type AdminReport, api } from '../../lib/api.js'
import { download } from '../../lib/download.js'
import * as session from '../../lib/session.js'
import { IconAlert, IconCheck, IconDownload } from '../../ui/icons.js'
import { useToast } from '../../ui/kit.js'
import { ErrorBox, Section, useAdminData, when } from './common.js'
import { presetUsersFilter } from './Users.js'

type Go = (tab: 'overview' | 'desk' | 'website' | 'users' | 'orgs' | 'invites' | 'audit' | 'system' | 'reports') => void

const loadInsights = (t: string) => api.admin.insights(t)

/** "Needs attention", most urgent first, each a way to the accounts behind it. */
export function NeedsAttention({ onGo }: { onGo: Go }) {
  const { data, error } = useAdminData(loadInsights)
  if (error) return <ErrorBox error={error} />
  if (!data) return <div className="skeleton" />
  return (
    <>
      <div className="admin-card attention-card">
        <div className="admin-card-head"><h2>Needs attention</h2></div>
        {data.attention.length === 0 ? (
          <p className="attention-ok"><IconCheck size={16} />Nothing needs attention. Accounts have two-factor sign-in, meet the policy, and nobody is waiting.</p>
        ) : (
          <ul className="attention-list">
            {data.attention.map((a) => (
              <li key={a.id} className={`attention attention-${a.level}`}>
                <span className="attention-level" aria-hidden="true"><IconAlert size={15} /></span>
                <span className="attention-text">
                  <span className="attention-title"><strong>{a.title}</strong><span className="attention-count">{a.count}</span></span>
                  <span className="muted small">{a.detail}</span>
                </span>
                <span className="visually-hidden">{a.level === 'high' ? 'Urgent' : a.level === 'medium' ? 'Important' : 'Worth a look'}</span>
                <button className="btn btn-secondary btn-sm" onClick={() => {
                  if (a.go.tab === 'users') presetUsersFilter({ ...(a.go.status ? { status: a.go.status as 'inactive' } : {}), ...(a.go.twoFactor ? { twoFactor: a.go.twoFactor as 'off' } : {}) })
                  onGo(a.go.tab as Parameters<Go>[0])
                }}>Review</button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <SigninChart daily={data.daily} />
    </>
  )
}

/** Sign-ins and failed sign-ins per day: one axis (both are counts), two
 *  lines, a legend and end labels, a crosshair with the day's numbers, and
 *  the same numbers as a table. */
export function SigninChart({ daily }: { daily: AdminInsights['daily'] }) {
  const W = 1000, H = 220, L = 36, R = 80, T = 12, B = 26
  const [hover, setHover] = useState<number | null>(null)
  const svg = useRef<SVGSVGElement>(null)
  const max = Math.max(4, ...daily.map((d) => Math.max(d.signin, d['signin-failed'])))
  const step = niceStep(max)
  const top = Math.ceil(max / step) * step
  const x = (i: number) => L + (i * (W - L - R)) / Math.max(1, daily.length - 1)
  const y = (v: number) => T + (H - T - B) * (1 - v / top)
  const path = (k: 'signin' | 'signin-failed') => daily.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d[k]).toFixed(1)}`).join(' ')
  const ticks = useMemo(() => Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step), [top, step])
  const total = (k: 'signin' | 'signin-failed') => daily.reduce((n, d) => n + d[k], 0)
  const last = daily.length - 1
  const fmt = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })

  function move(e: React.PointerEvent) {
    const r = svg.current?.getBoundingClientRect()
    if (!r) return
    const px = ((e.clientX - r.left) / r.width) * W
    setHover(Math.max(0, Math.min(last, Math.round(((px - L) / (W - L - R)) * last))))
  }

  const h = hover === null ? null : daily[hover]!
  return (
    <div className="admin-card chart-card">
      <div className="admin-card-head"><h2>Sign-ins, last 30 days</h2></div>
      <div className="chart-legend" aria-hidden="true">
        <span><i className="swatch swatch-1" />Sign-ins <strong>{total('signin')}</strong></span>
        <span><i className="swatch swatch-2" />Failed sign-ins <strong>{total('signin-failed')}</strong></span>
      </div>
      <div className="chart-wrap">
        <svg ref={svg} viewBox={`0 0 ${W} ${H}`} className="signin-chart" role="img"
             aria-label={`Sign-ins over the last 30 days: ${total('signin')} sign-ins and ${total('signin-failed')} failed sign-ins. The table below has each day.`}
             onPointerMove={move} onPointerLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid" x1={L} x2={W - R} y1={y(t)} y2={y(t)} />
              <text className="tick" x={L - 6} y={y(t)} dy="0.32em" textAnchor="end">{t}</text>
            </g>
          ))}
          {[0, Math.floor(last / 2), last].map((i) => <text key={i} className="tick" x={x(i)} y={H - 6} textAnchor={i === 0 ? 'start' : i === last ? 'end' : 'middle'}>{fmt(daily[i]!.day)}</text>)}
          <path className="line line-1" d={path('signin')} />
          <path className="line line-2" d={path('signin-failed')} />
          <text className="end-label" x={x(last) + 8} y={y(daily[last]!.signin)} dy="0.32em">Sign-ins</text>
          <text className="end-label" x={x(last) + 8} y={y(daily[last]!['signin-failed'])} dy={daily[last]!['signin-failed'] === daily[last]!.signin ? '1.4em' : '0.32em'}>Failed</text>
          {h ? (
            <g>
              <line className="crosshair" x1={x(hover!)} x2={x(hover!)} y1={T} y2={H - B} />
              <circle className="dot dot-1" cx={x(hover!)} cy={y(h.signin)} r={4.5} />
              <circle className="dot dot-2" cx={x(hover!)} cy={y(h['signin-failed'])} r={4.5} />
            </g>
          ) : null}
          <rect x={L} y={T} width={W - L - R} height={H - T - B} fill="transparent" />
        </svg>
        {h ? (
          <div className="chart-tip" style={{ left: `${(x(hover!) / W) * 100}%` }} role="status">
            <strong>{fmt(h.day)}</strong>
            <span><i className="swatch swatch-1" />{h.signin} sign-ins</span>
            <span><i className="swatch swatch-2" />{h['signin-failed']} failed</span>
            <span className="muted">{h.signup} new vaults</span>
          </div>
        ) : null}
      </div>
      <details className="chart-table">
        <summary>Show as a table</summary>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Day</th><th className="num">Sign-ins</th><th className="num">Failed</th><th className="num">New vaults</th></tr></thead>
            <tbody>{[...daily].reverse().map((d) => <tr key={d.day}><td>{fmt(d.day)}</td><td className="num">{d.signin}</td><td className="num">{d['signin-failed']}</td><td className="num">{d.signup}</td></tr>)}</tbody>
          </table>
        </div>
      </details>
    </div>
  )
}

function niceStep(max: number): number {
  const raw = max / 4
  const mag = 10 ** Math.floor(Math.log10(raw))
  for (const m of [1, 2, 5, 10]) if (raw <= m * mag) return Math.max(1, m * mag)
  return Math.max(1, 10 * mag)
}

// ── Reports ─────────────────────────────────────────────────────────────────

const loadReports = (t: string) => api.admin.reports(t)

export function Reports() {
  const toast = useToast()
  const { data, error } = useAdminData(loadReports)
  const [kind, setKind] = useState<string | null>(null)
  const [report, setReport] = useState<AdminReport | null>(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!kind) return
    let live = true
    setLoading(true); setReport(null)
    void session.token().then((t) => api.admin.report(t, kind)).then((r) => { if (live) setReport(r) })
      .catch((err: unknown) => toast(err instanceof Error ? err.message : 'Could not load the report.', 'error'))
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [kind, toast])

  return (
    <Section title="Reports" sub="About accounts and staff actions, never vault contents: the server cannot read those. Download any of them as CSV for a spreadsheet or an audit.">
      <ErrorBox error={error} />
      {!data ? <div className="skeletons">{[0, 1].map((i) => <div key={i} className="skeleton" />)}</div> : (
        <div className="report-grid">
          {data.reports.map((r) => (
            <div key={r.kind} className={`admin-card report-card ${kind === r.kind ? 'report-active' : ''}`}>
              <h2>{r.title}</h2>
              <div className="action-list">
                <button className="btn btn-secondary btn-sm" aria-pressed={kind === r.kind} onClick={() => setKind(kind === r.kind ? null : r.kind)}>{kind === r.kind ? 'Hide' : 'View'}</button>
                <button className="btn btn-secondary btn-sm" onClick={async () => {
                  try { download(`vault-${r.kind}-${new Date().toISOString().slice(0, 10)}.csv`, await api.admin.reportCsv(await session.token(), r.kind), 'text/csv') }
                  catch (err) { toast(err instanceof Error ? err.message : 'Could not download.', 'error') }
                }}><IconDownload size={15} />CSV</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {kind ? (
        <div className="admin-card report-view">
          <div className="admin-card-head"><h2>{report?.title ?? 'Loading…'}</h2>{report ? <span className="muted small">{report.rows.length} row(s)</span> : null}</div>
          {loading || !report ? <div className="skeleton" /> : report.rows.length === 0 ? <p className="muted">Nothing to report.</p> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr>{report.columns.map((c) => <th key={c}>{c.replace(/_/g, ' ')}</th>)}</tr></thead>
                <tbody>{report.rows.slice(0, 500).map((row, i) => <tr key={i}>{row.map((v, j) => <td key={j}>{v === true ? 'yes' : v === false ? 'no' : typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) ? when(v) : v ?? '—'}</td>)}</tr>)}</tbody>
              </table>
              {report.rows.length > 500 ? <p className="muted small">The first 500 rows; the CSV has all {report.rows.length}.</p> : null}
            </div>
          )}
        </div>
      ) : null}
    </Section>
  )
}
