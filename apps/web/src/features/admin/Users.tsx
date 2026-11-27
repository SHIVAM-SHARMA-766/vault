// The users list, built for a server with thousands of accounts: searched,
// filtered, sorted and paged on the server; actions on many accounts at once;
// and one account in full in a side panel, with every action in one place.

import { useCallback, useEffect, useRef, useState } from 'react'

import { type AdminUser, type AdminUserDetail, type AdminUserPage, type AdminUserQuery, type Role, api } from '../../lib/api.js'
import { download } from '../../lib/download.js'
import * as session from '../../lib/session.js'
import { IconDownload, IconRefresh, IconSearch, IconUser, IconX } from '../../ui/icons.js'
import { useToast } from '../../ui/kit.js'
import { day } from '../../lib/format.js'
import { EmptyState, ErrorBox, ROLE_HELP, ROLE_LABELS, Section, ago, run, when } from './common.js'

const PAGE_SIZES = [25, 50, 100, 200]
type Status = NonNullable<AdminUserQuery['status']>
const STATUS_CHIPS: { id: Status; label: string; count: keyof AdminUserPage['counts'] }[] = [
  { id: '', label: 'All', count: 'all' },
  { id: 'active', label: 'Active', count: 'active' },
  { id: 'disabled', label: 'Disabled', count: 'disabled' },
  { id: 'inactive', label: 'Inactive 90 days', count: 'inactive' },
  { id: 'never', label: 'Never signed in', count: 'never' },
]
const ROLES: Role[] = ['owner', 'admin', 'support', 'marketing', 'viewer', 'user']

/** A filter for the next time the list opens: "Review" on the overview's
 *  Needs attention sets it, then opens Users. */
let preset: Partial<AdminUserQuery> | null = null
export function presetUsersFilter(q: Partial<AdminUserQuery>): void { preset = q }

export const nameOf = (u: Pick<AdminUser, 'email' | 'label'>) => u.email || u.label || 'Unnamed account'

export function Users({ selfId, canWrite, canRoles }: { selfId: string; canWrite: boolean; canRoles: boolean }) {
  const toast = useToast()
  const [query, setQuery] = useState<AdminUserQuery>(() => { const q = { sort: 'created' as const, dir: 'desc' as const, limit: 50, offset: 0, ...preset }; preset = null; return q })
  const [text, setText] = useState('')
  const [page, setPage] = useState<AdminUserPage | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<string | null>(null)
  const seq = useRef(0)

  const load = useCallback(async (q: AdminUserQuery) => {
    const n = ++seq.current
    setLoading(true); setError('')
    try {
      const res = await api.admin.users(await session.token(), q)
      if (n === seq.current) setPage(res)
    } catch (err) { if (n === seq.current) setError(err instanceof Error ? err.message : 'Could not load.') } finally { if (n === seq.current) setLoading(false) }
  }, [])
  useEffect(() => { void load(query) }, [query, load])
  // Typing waits a moment before asking the server, and starts at page one.
  useEffect(() => {
    const t = setTimeout(() => setQuery((q) => (q.q ?? '') === text.trim() ? q : { ...q, q: text.trim(), offset: 0 }), 250)
    return () => clearTimeout(t)
  }, [text])
  const set = (patch: Partial<AdminUserQuery>) => { setSelected(new Set()); setQuery((q) => ({ ...q, offset: 0, ...patch })) }
  const reload = () => load(query)

  const users = page?.users ?? []
  const selectable = users.filter((u) => u.userId !== selfId && u.role !== 'owner')
  const allChecked = selectable.length > 0 && selectable.every((u) => selected.has(u.userId))
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  async function bulk(action: 'disable' | 'enable' | 'signout' | 'reset-2fa', verb: string) {
    const ids = [...selected]
    if ((action === 'disable' || action === 'reset-2fa') && !window.confirm(`${verb} ${ids.length} account(s)? It is recorded in the audit log.`)) return
    try {
      const res = await api.admin.bulkUsers(await session.token(), action, ids)
      const failed = res.results.filter((r) => !r.ok)
      toast(failed.length ? `${res.done} done, ${failed.length} not: ${failed[0]!.error}` : `${verb}: ${res.done} account(s)`, failed.length ? 'error' : undefined)
      setSelected(new Set()); await reload()
    } catch (err) { toast(err instanceof Error ? err.message : 'Could not do it.', 'error') }
  }

  async function exportCsv() {
    try {
      const token = await session.token()
      const rows: AdminUser[] = []
      for (let offset = 0; ; offset += 200) {
        const p = await api.admin.users(token, { ...query, offset, limit: 200 })
        rows.push(...p.users)
        if (rows.length >= p.total || p.users.length === 0) break
      }
      const cell = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s }
      const csv = ['email,label,role,status,two_factor,misses_policy,created,last_sign_in',
        ...rows.map((u) => [u.email, u.label, u.role, u.disabled ? 'disabled' : 'active', u.twoFactor, u.policyGap, u.createdAt, u.lastLoginAt].map(cell).join(','))].join('\n')
      download(`vault-users-${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv')
    } catch (err) { toast(err instanceof Error ? err.message : 'Could not export.', 'error') }
  }

  const from = page && page.total ? page.offset + 1 : 0
  const to = page ? Math.min(page.offset + page.users.length, page.total) : 0
  return (
    <Section title="Users" sub="Every account on this server. The email address is the username; vault contents stay encrypted and are never shown here."
             actions={<>
               <button className="btn btn-secondary btn-sm" onClick={() => void exportCsv()}><IconDownload size={15} />Export CSV</button>
               <button className="btn btn-secondary btn-sm" onClick={() => void reload()}><IconRefresh size={15} />Refresh</button>
             </>}>
      <div className="chip-row" role="group" aria-label="Status">
        {STATUS_CHIPS.map((c) => (
          <button key={c.id || 'all'} type="button" className={`chip ${(query.status ?? '') === c.id ? 'chip-active' : ''}`} aria-pressed={(query.status ?? '') === c.id} onClick={() => set({ status: c.id })}>
            {c.label}{page ? <span className="chip-count">{page.counts[c.count]}</span> : null}
          </button>
        ))}
      </div>
      <div className="table-toolbar">
        <label className="search-field">
          <IconSearch size={15} />
          <input type="search" placeholder="Search by email, label or id" aria-label="Search users" value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <select aria-label="Role" value={query.role ?? ''} onChange={(e) => set({ role: e.target.value })}>
          <option value="">Every role</option>
          {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
        </select>
        <select aria-label="Two-factor" value={query.twoFactor ?? ''} onChange={(e) => set({ twoFactor: e.target.value as '' | 'on' | 'off' })}>
          <option value="">Two-factor: any</option>
          <option value="on">Two-factor on</option>
          <option value="off">Two-factor off</option>
        </select>
        <select aria-label="Sort" value={`${query.sort}:${query.dir}`} onChange={(e) => { const [sort, dir] = e.target.value.split(':') as ['created' | 'lastLogin' | 'email', 'asc' | 'desc']; set({ sort, dir }) }}>
          <option value="created:desc">Newest first</option>
          <option value="created:asc">Oldest first</option>
          <option value="lastLogin:desc">Recently signed in</option>
          <option value="lastLogin:asc">Longest since sign-in</option>
          <option value="email:asc">Email A–Z</option>
          <option value="email:desc">Email Z–A</option>
        </select>
      </div>

      {canWrite && selected.size > 0 ? (
        <div className="bulk-bar" role="region" aria-label="Selected accounts">
          <strong>{selected.size} selected</strong>
          <button className="btn btn-secondary btn-sm" onClick={() => void bulk('disable', 'Disable')}>Disable</button>
          <button className="btn btn-secondary btn-sm" onClick={() => void bulk('enable', 'Enable')}>Enable</button>
          <button className="btn btn-secondary btn-sm" onClick={() => void bulk('signout', 'Sign out everywhere')}>Sign out everywhere</button>
          <button className="btn btn-secondary btn-sm" onClick={() => void bulk('reset-2fa', 'Reset two-factor for')}>Reset two-factor</button>
          <button className="link" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      ) : null}

      <ErrorBox error={error} />
      {!page ? <div className="skeletons">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" />)}</div>
        : page.total === 0 ? <EmptyState icon={<IconUser size={26} />} title={page.counts.all === 0 ? 'No accounts yet' : 'No account matches'}>{page.counts.all ? 'Try another search or filter.' : 'Invite people from Invitations.'}</EmptyState> : (
        <div className={`table-wrap ${loading ? 'is-loading' : ''}`}>
          <table className="data users-table">
            <thead>
              <tr>
                {canWrite ? <th className="check-col"><input type="checkbox" aria-label="Select every account on this page" checked={allChecked} disabled={!selectable.length}
                  onChange={() => setSelected(allChecked ? new Set() : new Set(selectable.map((u) => u.userId)))} /></th> : null}
                <th>Account</th><th>Role</th><th>Last sign-in</th><th>Created</th><th>Security</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const self = u.userId === selfId
                return (
                  <tr key={u.userId} className={`row-link ${u.disabled ? 'row-disabled' : ''}`} onClick={() => setOpen(u.userId)}>
                    {canWrite ? <td className="check-col" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" aria-label={`Select ${nameOf(u)}`} checked={selected.has(u.userId)} disabled={self || u.role === 'owner'} onChange={() => toggle(u.userId)} />
                    </td> : null}
                    <td>
                      <button type="button" className="acct-button acct-with-avatar" onClick={(e) => { e.stopPropagation(); setOpen(u.userId) }} aria-label={`Open ${nameOf(u)}`}>
                        <span className={`acct-avatar av-${hueOf(u.userId)}`} aria-hidden="true">{(u.email || u.label || '?')[0]!.toUpperCase()}</span>
                        <span className="acct">
                          <span className="acct-name" title={u.email || u.label || undefined}>{u.email || u.label || <span className="muted">Not signed in since addresses were kept</span>}
                            {self ? <span className="pill">You</span> : null}</span>
                          {u.email && u.label ? <span className="muted small">{u.label}</span> : null}
                        </span>
                      </button>
                    </td>
                    <td><span className={`pill ${u.role === 'user' ? '' : 'pill-accent'}`} title={ROLE_HELP[u.role]}>{ROLE_LABELS[u.role]}</span></td>
                    <td title={when(u.lastLoginAt)}>{ago(u.lastLoginAt)}</td>
                    <td title={when(u.createdAt)}>{day(u.createdAt)}</td>
                    <td>
                      {u.twoFactor ? <span className="pill pill-ok" title="Two-factor sign-in is on">2FA</span> : <span className="pill" title="Two-factor sign-in is off">No 2FA</span>}
                      {u.policyGap && !u.disabled ? <span className="pill pill-warn" title="Does not meet the server policies yet"> Misses policy</span> : null}
                    </td>
                    <td>{u.disabled ? <span className="pill pill-danger">Disabled</span> : <span className="pill pill-ok">Active</span>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {page && page.total > 0 ? (
        <div className="pager">
          <span className="muted small">{from}–{to} of {page.total}</span>
          <label className="muted small">Rows <select aria-label="Rows per page" value={query.limit} onChange={(e) => set({ limit: Number(e.target.value) })}>{PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
          <button className="btn btn-secondary btn-sm" disabled={page.offset === 0} onClick={() => setQuery((q) => ({ ...q, offset: Math.max(0, (q.offset ?? 0) - (q.limit ?? 50)) }))}>Previous</button>
          <button className="btn btn-secondary btn-sm" disabled={to >= page.total} onClick={() => setQuery((q) => ({ ...q, offset: (q.offset ?? 0) + (q.limit ?? 50) }))}>Next</button>
        </div>
      ) : null}

      {open ? <UserPanel id={open} selfId={selfId} canWrite={canWrite} canRoles={canRoles} onClose={() => setOpen(null)} onChanged={reload} /> : null}
    </Section>
  )
}

/** One account in full: what it is, its devices and organizations, what staff
 *  did to it, and every action, the dangerous ones last. */
function UserPanel({ id, selfId, canWrite, canRoles, onClose, onChanged }: {
  id: string; selfId: string; canWrite: boolean; canRoles: boolean; onClose: () => void; onChanged: () => Promise<void>
}) {
  const toast = useToast()
  const [d, setD] = useState<AdminUserDetail | null>(null)
  const [error, setError] = useState('')
  const [label, setLabel] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const load = useCallback(async () => {
    try { setD(await api.admin.user(await session.token(), id)) } catch (err) { setError(err instanceof Error ? err.message : 'Could not load.') }
  }, [id])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const act = async (fn: (t: string) => Promise<unknown>, done: string) => { if (await run(toast, fn, done)) { await load(); await onChanged() } }

  const u = d?.user
  const self = id === selfId
  const touchable = canWrite && !self && u?.role !== 'owner'
  const name = u ? nameOf(u) : ''
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="user-panel-title" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div>
            <h2 id="user-panel-title">{u ? name : 'Account'}</h2>
            {u ? <p className="muted small"><code className="acct-id">{u.userId}</code></p> : null}
          </div>
          <button className="icon-btn" aria-label="Close" onClick={onClose}><IconX size={18} /></button>
        </div>
        <ErrorBox error={error} />
        {!d || !u ? <div className="skeletons">{[0, 1, 2].map((i) => <div key={i} className="skeleton" />)}</div> : (
          <div className="drawer-body">
            <div className="pill-row">
              {u.disabled ? <span className="pill pill-danger">Disabled</span> : <span className="pill pill-ok">Active</span>}
              <span className={`pill ${u.role === 'user' ? '' : 'pill-accent'}`}>{ROLE_LABELS[u.role]}</span>
              {u.twoFactor ? <span className="pill pill-ok">Two-factor on</span> : <span className="pill pill-warn">Two-factor off</span>}
              {u.policyGap && !u.disabled ? <span className="pill pill-warn">Misses policy</span> : null}
              {self ? <span className="pill">You</span> : null}
            </div>
            <div className="mini-stats">
              <div><strong>{d.entries}</strong><span>items</span></div>
              <div><strong>{d.folders}</strong><span>folders</span></div>
              <div><strong>{d.sessions.length}</strong><span>devices</span></div>
              <div><strong>{d.orgs.length}</strong><span>organizations</span></div>
            </div>

            <h3>Account</h3>
            <dl className="drawer-facts">
              <dt>Created</dt><dd>{when(u.createdAt)}</dd>
              <dt>Last sign-in</dt><dd>{u.lastLoginAt ? `${when(u.lastLoginAt)} (${ago(u.lastLoginAt)})` : 'Never'}</dd>
              <dt>Account password</dt><dd>{d.accountPassword ? 'Set' : 'Not set yet (signs in once with the master password)'}</dd>
              <dt>Label</dt>
              <dd>{label !== null ? (
                <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void act((t) => api.admin.setLabel(t, id, label), 'Label saved').then(() => setLabel(null)) }}>
                  <input autoFocus value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} aria-label="Label" />
                  <button className="btn btn-primary btn-sm" type="submit">Save</button>
                  <button className="link" type="button" onClick={() => setLabel(null)}>Cancel</button>
                </form>
              ) : <>{u.label || <span className="muted">None</span>}{canWrite ? <> · <button className="link" onClick={() => setLabel(u.label ?? '')}>Edit label</button></> : null}</>}</dd>
              <dt>Role</dt>
              <dd>{canRoles && u.role !== 'owner' && !self ? (
                <select className="role-select" value={u.role} aria-label="Role" title={ROLE_HELP[u.role]}
                        onChange={(e) => void act((t) => api.admin.setRole(t, id, e.target.value as Role), `Role set to ${ROLE_LABELS[e.target.value as Role]}`)}>
                  {(['admin', 'support', 'marketing', 'viewer', 'user'] as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                </select>
              ) : <span title={ROLE_HELP[u.role]}>{ROLE_LABELS[u.role]}</span>}</dd>
            </dl>

            <h3>Devices</h3>
            {d.sessions.length === 0 ? <p className="muted small">Not signed in anywhere.</p> : (
              <ul className="plain-list">{d.sessions.map((s, i) => <li key={i}><strong>{s.device}</strong> <span className="muted small">{s.ip ? `${s.ip} · ` : ''}last used {ago(s.lastUsedAt)}</span></li>)}</ul>
            )}

            <h3>Organizations</h3>
            {d.orgs.length === 0 ? <p className="muted small">Not in any organization.</p> : (
              <ul className="plain-list">{d.orgs.map((o) => <li key={o.orgId}><strong>{o.name || 'Unnamed organization'}</strong> <span className="muted small">{o.kind === 'direct' ? 'direct share' : o.role}</span></li>)}</ul>
            )}

            <h3>Staff activity</h3>
            {d.activity.length === 0 ? <p className="muted small">No admin action has touched this account.</p> : (
              <ul className="plain-list">{d.activity.map((a, i) => <li key={i}><span>{a.action}</span> <span className="muted small">{a.actorLabel ? `by ${a.actorLabel} · ` : ''}{when(a.at)}{a.detail ? ` · ${a.detail}` : ''}</span></li>)}</ul>
            )}

            {canWrite ? <>
              <h3>Actions</h3>
              <div className="action-list">
                <button className="btn btn-secondary btn-sm" disabled={d.sessions.length === 0} onClick={() => void act((t) => api.admin.revokeSessions(t, id), 'Sessions revoked')}>Sign out everywhere</button>
                {touchable && u.twoFactor ? <button className="btn btn-secondary btn-sm" onClick={() => {
                  if (window.confirm(`Turn off two-factor sign-in for ${name}? Use this only for someone who has lost both their phone and their recovery codes. It is recorded in the audit log.`)) void act((t) => api.admin.resetTwoFactor(t, id), 'Two-factor sign-in reset')
                }}>Reset two-factor sign-in</button> : null}
                {touchable ? <button className="btn btn-secondary btn-sm" onClick={() => {
                  if (window.confirm(`Clear the account password of ${name}? They then sign in once with their master password and choose a new one. Use this when they forgot it and this server sends no email. It is recorded in the audit log.`)) void act((t) => api.admin.resetAccountPassword(t, id), 'Account password cleared')
                }}>Reset account password</button> : null}
              </div>
              {touchable ? <>
                <h3 className="danger-title">Danger zone</h3>
                <div className="action-list">
                  <button className="btn btn-secondary btn-sm" onClick={() => void act((t) => api.admin.setDisabled(t, id, !u.disabled), u.disabled ? 'Account enabled' : 'Account disabled')}>{u.disabled ? 'Enable' : 'Disable'}</button>
                  {!u.disabled ? <button className="btn btn-secondary btn-sm" aria-label={`Offboard ${name}`} onClick={() => {
                    if (window.confirm(`Offboard ${name}? They are disabled, signed out everywhere, and removed from every organization. Shared passwords they could see are listed for their colleagues to change.`)) void act((t) => api.admin.offboard(t, id), 'Offboarded: disabled, signed out, removed from organizations')
                  }}>Offboard</button> : null}
                  <button className="btn btn-danger btn-sm" onClick={() => { setDeleting(true); setConfirmText('') }}>Delete account</button>
                </div>
              </> : null}
            </> : null}
          </div>
        )}

        {deleting && u ? (
          <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="del-title">
            <div className="modal">
              <h2 id="del-title">Delete this account?</h2>
              <p className="muted"><strong>{name}</strong> and its {d?.entries ?? 0} encrypted item(s) will be removed permanently. Nobody can recover them: the server never held a key that opens them, and the only other copy is the daily export.</p>
              <label htmlFor="del-confirm" className="field-label">Type <code>delete</code> to confirm</label>
              <input id="del-confirm" autoFocus value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
              <div className="modal-actions">
                <button className="btn btn-secondary" onClick={() => setDeleting(false)}>Cancel</button>
                <button className="btn btn-danger" disabled={confirmText !== 'delete'} onClick={async () => {
                  if (await run(toast, (t) => api.admin.deleteUser(t, id), 'Account deleted')) { setDeleting(false); onClose(); await onChanged() }
                }}>Delete permanently</button>
              </div>
            </div>
          </div>
        ) : null}
      </aside>
    </div>
  )
}

/** A stable colour for an account's initial, from its id (six hues). */
function hueOf(id: string): number {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h % 6
}
