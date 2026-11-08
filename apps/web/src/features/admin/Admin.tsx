// The operator's panel. It manages accounts and the service; it cannot read a
// vault, and it never sees an address — the server holds neither in a form
// that could be shown. Accounts are told apart by the label on the invitation
// that created them, or one set here.
//
// Every action is checked again by the server. Hiding this panel from
// non-admins is a courtesy, not the control.

import { useEffect, useState } from 'react'

import {
  type AdminAudit,
  type AdminInvite,
  type AdminOverview,
  type AdminUser,
  type InstanceProfile,
  type Permission,
  type RegistrationMode,
  type Role,
  api,
} from '../../lib/api.js'
import { ErrorBox, Section, ago, run, useAdminData, when } from './common.js'
import { Desk } from './Desk.js'
import { Website } from './Website.js'
import { refresh as refreshInstance } from '../../lib/instance.js'
import * as session from '../../lib/session.js'
import {
  IconAlert, IconCheck, IconEdit, IconGlobe, IconInbox, IconGrid, IconKey, IconNote,
  IconPlus, IconRefresh, IconShield, IconTrash, IconUser, IconX,
} from '../../ui/icons.js'
import { CopyButton, useToast } from '../../ui/kit.js'
import { Shell } from '../../ui/Shell.js'
import { href, navigate } from '../../lib/router.js'

type Tab = 'overview' | 'desk' | 'website' | 'users' | 'orgs' | 'invites' | 'audit'

const TABS: { id: Tab; label: string; needs: Permission; Icon: (p: { size?: number }) => JSX.Element }[] = [
  { id: 'overview', label: 'Overview', needs: 'overview.read', Icon: IconGrid },
  { id: 'desk', label: 'Service desk', needs: 'desk.read', Icon: IconInbox },
  { id: 'website', label: 'Website', needs: 'site.read', Icon: IconGlobe },
  { id: 'users', label: 'Users', needs: 'users.read', Icon: IconUser },
  { id: 'orgs', label: 'Organizations', needs: 'users.read', Icon: IconGrid },
  { id: 'invites', label: 'Invitations', needs: 'invites.read', Icon: IconKey },
  { id: 'audit', label: 'Audit log', needs: 'audit.read', Icon: IconNote },
]

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner', admin: 'Admin', support: 'Support', marketing: 'Marketing', viewer: 'Viewer', user: 'User',
}
const ROLE_HELP: Record<Role, string> = {
  owner: 'Everything, including roles. Set in the host configuration.',
  admin: 'Users, invitations, registration and the website. Cannot change roles.',
  support: 'The service desk and invitations. Escalates account changes to an admin.',
  marketing: 'The website only: text, search details, images and the banner.',
  viewer: 'Can see everything in this panel and change nothing.',
  user: 'No admin access.',
}

export function Admin({ state, tab: requested }: { state: session.Unlocked; tab: string | null }) {
  const perms = new Set<Permission>(state.permissions ?? [])
  const tabs = TABS.filter((t) => perms.has(t.needs))
  // The tab is part of the address (/app/admin/users), so reload and back work.
  const tab: Tab = tabs.find((t) => t.id === requested)?.id ?? tabs[0]?.id ?? 'overview'
  const setTab = (t: Tab) => navigate(href({ name: 'admin', tab: t }))
  const role: Role = state.role ?? 'user'

  return (
    <Shell state={state} tag={ROLE_LABELS[role]}>

      <div className="admin-layout">
        <nav className="sidebar" aria-label="Admin sections">
          {tabs.map(({ id, label, Icon }) => (
            <button key={id} className={`side-item ${tab === id ? 'side-active' : ''}`} onClick={() => setTab(id)} aria-current={tab === id}>
              <Icon size={16} /><span>{label}</span>
            </button>
          ))}
          <div className="sidebar-foot">
            <IconShield size={14} /> You can manage accounts here, but not read them. Vault contents and addresses never reach the server in readable form.
          </div>
        </nav>

        <div className="filter-chips admin-chips">
          {tabs.map(({ id, label }) => (
            <button key={id} className={`chip ${tab === id ? 'chip-active' : ''}`} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>

        <main className="admin-main">
          {tab === 'overview' && perms.has('overview.read') ? <Overview onGo={setTab} canWrite={perms.has('settings.write')} /> : null}
          {tab === 'desk' && perms.has('desk.read') ? <Desk selfId={state.userId} canWrite={perms.has('desk.write')} canApprove={perms.has('invites.write')} canReset={perms.has('users.write')} /> : null}
          {tab === 'website' && perms.has('site.read') ? <Website canWrite={perms.has('site.write')} canPublish={perms.has('site.publish')} /> : null}
          {tab === 'users' && perms.has('users.read') ? <Users selfId={state.userId} canWrite={perms.has('users.write')} canRoles={perms.has('roles.write')} /> : null}
          {tab === 'orgs' && perms.has('users.read') ? <AdminOrgs canWrite={perms.has('users.write')} /> : null}
          {tab === 'invites' && perms.has('invites.read') ? <Invites canWrite={perms.has('invites.write')} canRoles={perms.has('roles.write')} /> : null}
          {tab === 'audit' && perms.has('audit.read') ? <Audit /> : null}
        </main>
      </div>
    </Shell>
  )
}

// ── Data loading ──────────────────────────────────────────────────────────

// ── Overview ──────────────────────────────────────────────────────────────

const loadOverview = (t: string) => api.admin.overview(t)

function Overview({ onGo, canWrite }: { onGo: (t: Tab) => void; canWrite: boolean }) {
  const toast = useToast()
  const { data, error, reload } = useAdminData(loadOverview)

  const backupAgeHours = data?.lastBackup?.at ? (Date.now() - Date.parse(data.lastBackup.at)) / 3_600_000 : null
  const backupStale = backupAgeHours === null || backupAgeHours > 36

  async function setMode(mode: RegistrationMode) {
    if (await run(toast, (t) => api.admin.setRegistration(t, mode), `Registration is now ${mode}`)) await reload()
  }

  return (
    <Section title="Overview" sub="The state of the service at a glance."
             actions={<button className="btn btn-secondary btn-sm" onClick={() => void reload()}><IconRefresh size={15} />Refresh</button>}>
      <ErrorBox error={error} />
      {!data ? <div className="skeletons">{[0, 1].map((i) => <div key={i} className="skeleton" />)}</div> : (
        <>
          <div className="stats">
            <Stat label="Accounts" value={data.users} note={data.disabledUsers ? `${data.disabledUsers} disabled` : 'all active'} onClick={() => onGo('users')} />
            <Stat label="Encrypted items" value={data.entries} note="across every vault" />
            <Stat label="Active sessions" value={data.activeSessions} note="signed-in devices" />
            <Stat label="Open invitations" value={data.activeInvites} note="unused and unexpired" onClick={() => onGo('invites')} />
            <Stat label="Open tickets" value={data.openTickets} note="in the service desk" onClick={() => onGo('desk')} />
          </div>

          <div className="admin-cards">
            <div className={`admin-card ${backupStale ? 'card-warn' : ''}`}>
              <div className="admin-card-head">
                <span className={`dot ${backupStale ? 'dot-warn' : 'dot-ok'}`} />
                <h2>Backups</h2>
              </div>
              {data.lastBackup?.at ? (
                <>
                  <p className="big">{ago(data.lastBackup.at)}</p>
                  <p className="muted small">{when(data.lastBackup.at)} · {data.lastBackup.object} · {data.lastBackup.bytes?.toLocaleString()} bytes</p>
                </>
              ) : <p className="big">No backup recorded</p>}
              {backupStale ? (
                <p className="alert alert-warn"><IconAlert size={16} /><span>The daily export should run every 24 hours. Check <code>vault-backup.timer</code> on the host — this is the only backup there is.</span></p>
              ) : <p className="muted small">The daily export is the only backup. It runs once a day.</p>}
            </div>

            <div className="admin-card">
              <div className="admin-card-head">
                <span className={`dot ${data.registration === 'open' || data.registrationForcedOpen ? 'dot-warn' : 'dot-ok'}`} />
                <h2>Registration</h2>
              </div>
              <div className="segmented" role="radiogroup" aria-label="Registration">
                {(['closed', 'invite', 'open'] as RegistrationMode[]).map((m) => (
                  <button key={m} role="radio" aria-checked={data.registration === m} disabled={!canWrite}
                          className={data.registration === m ? 'seg-active' : ''} onClick={() => void setMode(m)}>
                    {m === 'closed' ? 'Closed' : m === 'invite' ? 'Invite only' : 'Open'}
                  </button>
                ))}
              </div>
              <p className="muted small">
                {data.registration === 'closed' ? 'Nobody can create an account.'
                  : data.registration === 'invite' ? 'Only someone holding an invitation code can create an account.'
                  : 'Anyone who finds this address can create an account.'}
              </p>
              {data.registrationForcedOpen ? (
                <p className="alert alert-warn"><IconAlert size={16} /><span>Registration is forced open on the host (<code>ALLOW_REGISTRATION</code>). Close it with <code>scripts/registration.sh close</code>.</span></p>
              ) : null}
            </div>

            <MailCard on={data.mail} canWrite={canWrite} />
            <ProfileCard canWrite={canWrite} />

            <div className="admin-card">
              <div className="admin-card-head"><span className="dot dot-ok" /><h2>Server</h2></div>
              <p className="big">Running</p>
              <p className="muted small">Up {Math.floor(data.uptimeSeconds / 3600)} h {Math.floor((data.uptimeSeconds % 3600) / 60)} min · server time {when(data.serverTime)}</p>
            </div>
          </div>
        </>
      )}
    </Section>
  )
}

/** The server's name and support contact: shown on the sign-in screen and the
 *  help page, and the Reply-To of every email Vault sends. */
function ProfileCard({ canWrite }: { canWrite: boolean }) {
  const toast = useToast()
  const [form, setForm] = useState<InstanceProfile | null>(null)
  const [saved, setSaved] = useState<InstanceProfile | null>(null)
  useEffect(() => {
    void (async () => {
      try {
        const s = await api.admin.settings(await session.token())
        setForm(s.profile); setSaved(s.profile)
      } catch { /* the card says it could not load */ }
    })()
  }, [])
  if (!form) return <div className="admin-card"><div className="admin-card-head"><h2>Name and support</h2></div><p className="muted small">Loading…</p></div>
  const dirty = JSON.stringify(form) !== JSON.stringify(saved)
  const set = (k: keyof InstanceProfile) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value })
  return (
    <form className="admin-card admin-card-wide" aria-labelledby="profile-title" onSubmit={async (e) => {
      e.preventDefault()
      if (await run(toast, (t) => api.admin.setProfile(t, form), 'Name and support contact saved')) { setSaved(form); refreshInstance() }
    }}>
      <div className="admin-card-head"><span className={`dot ${saved?.supportEmail ? 'dot-ok' : 'dot-muted'}`} /><h2 id="profile-title">Name and support</h2></div>
      <p className="muted small">Shown on the sign-in screen and the help page. Replies to any email Vault sends go to the support address.</p>
      <div className="grid-3">
        <div className="field">
          <label htmlFor="pf-name">Server name</label>
          <input id="pf-name" maxLength={60} placeholder="Vault" disabled={!canWrite} value={form.name} onChange={set('name')} />
        </div>
        <div className="field">
          <label htmlFor="pf-email">Support email</label>
          <input id="pf-email" type="email" maxLength={254} placeholder="support@example.com" disabled={!canWrite} value={form.supportEmail} onChange={set('supportEmail')} />
        </div>
        <div className="field">
          <label htmlFor="pf-url">Help page (optional)</label>
          <input id="pf-url" type="url" maxLength={300} placeholder="https://…" disabled={!canWrite} value={form.supportUrl} onChange={set('supportUrl')} />
        </div>
      </div>
      {canWrite ? <div className="settings-actions"><button className="btn btn-primary btn-sm" type="submit" disabled={!dirty}>Save</button></div> : null}
    </form>
  )
}

function MailCard({ on, canWrite }: { on: boolean; canWrite: boolean }) {
  const toast = useToast()
  const [to, setTo] = useState('')
  return (
    <div className="admin-card">
      <div className="admin-card-head"><span className={`dot ${on ? 'dot-ok' : 'dot-muted'}`} /><h2>Mail</h2></div>
      <p className="big">{on ? 'Set up' : 'Off'}</p>
      {on ? (
        canWrite ? (
          <form className="inline-form" onSubmit={async (e) => { e.preventDefault(); if (await run(toast, (t) => api.admin.testMail(t, to), `Test message sent to ${to}`)) setTo('') }}>
            <input type="email" required placeholder="Send a test to…" aria-label="Test email address" value={to} onChange={(e) => setTo(e.target.value)} />
            <button className="btn btn-secondary btn-sm" type="submit">Send test</button>
          </form>
        ) : <p className="muted small">Invitations can be emailed; sign-in notices are sent.</p>
      ) : <p className="muted small">Set SMTP_HOST and MAIL_FROM to email invitations and sign-in notices. See docs/configuration.md.</p>}
    </div>
  )
}

function Stat({ label, value, note, onClick }: { label: string; value: number; note: string; onClick?: () => void }) {
  const body = (
    <>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value.toLocaleString()}</span>
      <span className="stat-note">{note}</span>
    </>
  )
  return onClick ? <button className="stat stat-link" onClick={onClick}>{body}</button> : <div className="stat">{body}</div>
}

// ── Users ─────────────────────────────────────────────────────────────────

const loadUsers = (t: string) => api.admin.users(t)

function Users({ selfId, canWrite, canRoles }: { selfId: string; canWrite: boolean; canRoles: boolean }) {
  const toast = useToast()
  const { data, error, reload } = useAdminData(loadUsers)
  const [editing, setEditing] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [deleting, setDeleting] = useState<AdminUser | null>(null)
  const [confirmText, setConfirmText] = useState('')

  async function saveLabel(id: string) {
    if (await run(toast, (t) => api.admin.setLabel(t, id, label), 'Label saved')) { setEditing(null); await reload() }
  }

  return (
    <Section title="Users" sub="Accounts are identified by label. Addresses are stored only as keyed hashes and cannot be shown.">
      <ErrorBox error={error} />
      {!data ? <div className="skeletons">{[0, 1, 2].map((i) => <div key={i} className="skeleton" />)}</div>
        : data.users.length === 0 ? <div className="empty"><h3>No accounts yet</h3></div> : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Account</th><th>Role</th><th>Created</th><th>Last sign-in</th><th className="num">Items</th><th className="num">Sessions</th><th>Status</th>{canWrite ? <th aria-label="Actions" /> : null}</tr>
            </thead>
            <tbody>
              {data.users.map((u) => {
                const self = u.userId === selfId
                return (
                  <tr key={u.userId} className={u.disabled ? 'row-disabled' : ''}>
                    <td>
                      {editing === u.userId ? (
                        <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void saveLabel(u.userId) }}>
                          <input autoFocus value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} aria-label="Label" />
                          <button className="icon-btn" type="submit" aria-label="Save label"><IconCheck size={16} /></button>
                          <button className="icon-btn" type="button" onClick={() => setEditing(null)} aria-label="Cancel"><IconX size={16} /></button>
                        </form>
                      ) : (
                        <div className="acct">
                          <span className="acct-name">{u.label || <span className="muted">Unlabelled</span>}
                            {self ? <span className="pill">You</span> : null}
                          </span>
                          <code className="acct-id">{u.userId.slice(0, 8)}…</code>
                        </div>
                      )}
                    </td>
                    <td>
                      {canRoles && u.role !== 'owner' && !self ? (
                        <select className="role-select" value={u.role} aria-label="Role" title={ROLE_HELP[u.role]}
                                onChange={async (e) => { if (await run(toast, (t) => api.admin.setRole(t, u.userId, e.target.value as Role), `Role set to ${ROLE_LABELS[e.target.value as Role]}`)) await reload() }}>
                          {(['admin', 'support', 'marketing', 'viewer', 'user'] as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                        </select>
                      ) : <span className={`pill ${u.role === 'user' ? '' : 'pill-accent'}`} title={ROLE_HELP[u.role]}>{ROLE_LABELS[u.role]}</span>}
                    </td>
                    <td>{when(u.createdAt)}</td>
                    <td title={when(u.lastLoginAt)}>{ago(u.lastLoginAt)}</td>
                    <td className="num">{u.entries}</td>
                    <td className="num">{u.sessions}</td>
                    <td>
                      {u.disabled ? <span className="pill pill-danger">Disabled</span> : <span className="pill pill-ok">Active</span>}
                      {u.twoFactor ? <span className="pill pill-accent" title="Two-factor sign-in is on"> 2FA</span> : null}
                    </td>
                    {canWrite ? <td>
                      <div className="row-actions">
                        <button className="icon-btn" title="Edit label" aria-label="Edit label" onClick={() => { setEditing(u.userId); setLabel(u.label ?? '') }}><IconEdit size={15} /></button>
                        <button className="icon-btn" title="Sign out everywhere" aria-label="Sign out everywhere" disabled={u.sessions === 0}
                                onClick={async () => { if (await run(toast, (t) => api.admin.revokeSessions(t, u.userId), 'Sessions revoked')) await reload() }}>
                          <IconRefresh size={15} />
                        </button>
                        {!self && u.twoFactor ? (
                          <button className="icon-btn" title="Reset two-factor sign-in" aria-label="Reset two-factor sign-in"
                                  onClick={async () => {
                                    if (!window.confirm(`Turn off two-factor sign-in for ${u.label || 'this account'}? Use this only for someone who has lost both their phone and their recovery codes. It is recorded in the audit log.`)) return
                                    if (await run(toast, (t) => api.admin.resetTwoFactor(t, u.userId), 'Two-factor sign-in reset')) await reload()
                                  }}>
                            <IconShield size={15} />
                          </button>
                        ) : null}
                        {!self ? (
                          <>
                            <button className="btn btn-secondary btn-sm"
                                    onClick={async () => { if (await run(toast, (t) => api.admin.setDisabled(t, u.userId, !u.disabled), u.disabled ? 'Account enabled' : 'Account disabled')) await reload() }}>
                              {u.disabled ? 'Enable' : 'Disable'}
                            </button>
                            <button className="icon-btn icon-danger" title="Delete account" aria-label="Delete account"
                                    onClick={() => { setDeleting(u); setConfirmText('') }}>
                              <IconTrash size={15} />
                            </button>
                          </>
                        ) : null}
                      </div>
                    </td> : null}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {deleting ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="del-title">
          <div className="modal">
            <h2 id="del-title">Delete this account?</h2>
            <p className="muted">
              <strong>{deleting.label || 'This unlabelled account'}</strong> and its {deleting.entries} encrypted item(s)
              will be removed permanently. Nobody can recover them — the server never held a key that opens them,
              and the only other copy is the daily export.
            </p>
            <label htmlFor="del-confirm" className="field-label">Type <code>delete</code> to confirm</label>
            <input id="del-confirm" autoFocus value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setDeleting(null)}>Cancel</button>
              <button className="btn btn-danger" disabled={confirmText !== 'delete'}
                      onClick={async () => {
                        if (await run(toast, (t) => api.admin.deleteUser(t, deleting.userId), 'Account deleted')) { setDeleting(null); await reload() }
                      }}>
                Delete permanently
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </Section>
  )
}

// ── Invitations ───────────────────────────────────────────────────────────

const loadInvites = (t: string) => api.admin.invites(t)

function Invites({ canWrite, canRoles }: { canWrite: boolean; canRoles: boolean }) {
  const toast = useToast()
  const [role, setRole] = useState<Role>('user')
  const { data, error, reload } = useAdminData(loadInvites)
  const [label, setLabel] = useState('')
  const [days, setDays] = useState(7)
  const [email, setEmail] = useState('')
  const [issued, setIssued] = useState<{ code: string; label: string; expiresAt: string; emailedTo?: string } | null>(null)
  const [busy, setBusy] = useState(false)

  async function create(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const res = await api.admin.createInvite(await session.token(), label.trim(), days, role, email.trim())
      setIssued({ code: res.code, label: res.invite.label, expiresAt: res.invite.expiresAt, ...(res.emailed ? { emailedTo: email.trim() } : {}) })
      if (email.trim() && !res.emailed) toast('The invitation was created, but the email could not be sent. Copy the code instead.', 'error')
      setRole('user')
      setLabel('')
      setEmail('')
      await reload()
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create the invitation.', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title="Invitations" sub="Single-use codes. Registration must be set to “Invite only” or “Open” for them to work.">
      <ErrorBox error={error} />

      {canWrite ? <form className="admin-card invite-form" onSubmit={create}>
        <div className="field">
          <label htmlFor="inv-label">Who is it for?</label>
          <input id="inv-label" required maxLength={80} placeholder="e.g. Rahul — personal laptop" value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="inv-days">Expires after</label>
          <select id="inv-days" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[1, 3, 7, 14, 30].map((d) => <option key={d} value={d}>{d} day{d > 1 ? 's' : ''}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="inv-email">Email it to <span className="muted">(optional)</span></label>
          <input id="inv-email" type="email" placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        {canRoles ? (
          <div className="field">
            <label htmlFor="inv-role">Starts as</label>
            <select id="inv-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {(['user', 'viewer', 'support', 'marketing', 'admin'] as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </select>
          </div>
        ) : null}
        <button className="btn btn-primary" type="submit" disabled={busy || !label.trim()}><IconPlus size={16} />Create invitation</button>
      </form> : null}

      {issued ? (
        <div className="issued">
          <p><strong>Invitation for {issued.label}</strong> — expires {when(issued.expiresAt)}. {issued.emailedTo ? `Emailed to ${issued.emailedTo}, with a link. ` : ''}This code is shown once; only its hash is stored.</p>
          <div className="recovery-key"><code>{issued.code}</code><CopyButton value={issued.code} label="Invitation code" /></div>
          <button className="link" onClick={() => setIssued(null)}>Done</button>
        </div>
      ) : null}

      {!data ? null : data.invites.length === 0 ? <p className="muted">No invitations yet.</p> : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>For</th><th>Role</th><th>Created</th><th>Expires</th><th>Status</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {data.invites.map((i: AdminInvite) => (
                <tr key={i.id}>
                  <td className="strong">{i.label}</td>
                  <td>{ROLE_LABELS[i.role] ?? 'User'}</td>
                  <td>{when(i.createdAt)}</td>
                  <td>{i.status === 'used' ? `Used ${when(i.usedAt)}` : when(i.expiresAt)}</td>
                  <td><span className={`pill ${i.status === 'active' ? 'pill-ok' : i.status === 'used' ? 'pill-accent' : ''}`}>{i.status}</span></td>
                  <td>
                    {i.status !== 'used' && canWrite ? (
                      <button className="icon-btn icon-danger" title="Revoke" aria-label="Revoke invitation"
                              onClick={async () => { if (await run(toast, (t) => api.admin.deleteInvite(t, i.id), 'Invitation revoked')) await reload() }}>
                        <IconTrash size={15} />
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}

// ── Audit ─────────────────────────────────────────────────────────────────

const loadAudit = (t: string) => api.admin.audit(t)

const ACTIONS: Record<string, string> = {
  'settings.registration': 'Changed registration',
  'invite.create': 'Created invitation',
  'invite.delete': 'Revoked invitation',
  'user.label': 'Relabelled account',
  'user.disable': 'Disabled account',
  'user.enable': 'Enabled account',
  'user.revoke-sessions': 'Signed account out everywhere',
  'user.delete': 'Deleted account',
  'user.role': 'Changed role',
  'user.reset-2fa': 'Reset two-factor sign-in',
  'site.publish': 'Published the website',
  'site.rollback': 'Rolled the website back',
  'site.discard-draft': 'Discarded the website draft',
  'media.upload': 'Uploaded an image',
  'media.delete': 'Deleted an image',
}

const loadOrgs = (t: string) => api.admin.orgs(t)

function AdminOrgs({ canWrite }: { canWrite: boolean }) {
  const toast = useToast()
  const { data, error, reload } = useAdminData(loadOrgs)
  return (
    <Section title="Organizations" sub="Every organization on this server, by counts. Names, collections and items are encrypted for their members; nobody here can open them.">
      <ErrorBox error={error} />
      {!data ? <div className="skeletons"><div className="skeleton" /></div> : data.orgs.length === 0 ? <div className="empty"><h3>No organizations yet</h3><p>Members create them from Account menu → Organizations.</p></div> : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Name (as typed by its creator)</th><th className="num">Members</th><th className="num">Collections</th><th className="num">Items</th><th>Policies</th><th>Created</th>{canWrite ? <th aria-label="Actions" /> : null}</tr></thead>
            <tbody>
              {data.orgs.map((o) => (
                <tr key={o.id}>
                  <td>{o.hint || <span className="muted">Unnamed</span>}{o.rotationDue ? <span className="pill pill-danger" title="A collection key should be rotated by one of its managers">{o.rotationDue} key rotation due</span> : null}</td>
                  <td className="num" title={`${o.awaiting} awaiting confirmation, ${o.pending} invited`}>{o.members}{o.awaiting + o.pending ? <span className="muted"> +{o.awaiting + o.pending}</span> : null}</td>
                  <td className="num">{o.collections}</td>
                  <td className="num">{o.items}</td>
                  <td>{[o.policies.requireTwoFactor && '2FA', o.policies.minPasswordScore > 0 && 'password', o.policies.maxIdleMinutes && `${o.policies.maxIdleMinutes} min lock`].filter(Boolean).join(' · ') || <span className="muted">none</span>}</td>
                  <td>{when(o.createdAt)}</td>
                  {canWrite ? <td><button className="icon-btn icon-danger" aria-label={`Delete ${o.hint}`} title="Delete organization" onClick={async () => {
                    if (!window.confirm(`Delete "${o.hint}" and everything in it — its collections and their items — for all its members? This cannot be undone and is recorded in the audit log.`)) return
                    if (await run(toast, (t) => api.admin.deleteOrg(t, o.id), 'Organization deleted')) await reload()
                  }}><IconTrash size={15} /></button></td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}

function Audit() {
  const { data, error, reload } = useAdminData(loadAudit)
  return (
    <Section title="Audit log" sub="Every admin action, kept for a year. Written before the action runs, so nothing here happens unrecorded."
             actions={<button className="btn btn-secondary btn-sm" onClick={() => void reload()}><IconRefresh size={15} />Refresh</button>}>
      <ErrorBox error={error} />
      {!data ? null : data.records.length === 0 ? <p className="muted">No admin actions yet.</p> : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>When</th><th>Action</th><th>Detail</th><th>By</th></tr></thead>
            <tbody>
              {data.records.map((r: AdminAudit, i) => (
                <tr key={`${r.at}-${i}`}>
                  <td>{when(r.at)}</td>
                  <td className="strong">{ACTIONS[r.action] ?? r.action}</td>
                  <td>{[r.targetLabel ?? (r.target ? `${r.target.slice(0, 8)}…` : null), r.detail].filter(Boolean).join(' · ') || '—'}</td>
                  <td>{r.actorLabel ?? <code className="acct-id">{r.actor.slice(0, 8)}…</code>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}

export type { AdminOverview }
