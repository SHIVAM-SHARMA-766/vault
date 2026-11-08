// The operator's panel. It manages accounts and the service; it cannot read a
// vault, and it never sees an address — the server holds neither in a form
// that could be shown. Accounts are told apart by the label on the invitation
// that created them, or one set here.
//
// Every action is checked again by the server. Hiding this panel from
// non-admins is a courtesy, not the control.

import { type ReactElement, useEffect, useState } from 'react'

import {
  type AdminAudit,
  type AdminInvite,
  type AdminOverview,
  type AdminUser,
  type InstanceProfile,
  type UpdateStatus,
  type Permission,
  type RegistrationMode,
  type Role,
  type ServerPolicy,
  api,
} from '../../lib/api.js'
import { STRENGTH_LABELS, describeMinutes } from '@vault/core'
import { ErrorBox, Section, ago, run, useAdminData, when } from './common.js'
import { Desk } from './Desk.js'
import { Website } from './Website.js'
import { System } from './System.js'
import { download } from '../../lib/download.js'
import { SetupWizard, wizardDone } from './SetupWizard.js'
import { applyBranding, refresh as refreshInstance } from '../../lib/instance.js'
import * as session from '../../lib/session.js'
import {
  IconAlert, IconCheck, IconEdit, IconGlobe, IconInbox, IconGrid, IconKey, IconNote,
  IconDownload, IconPlus, IconRefresh, IconShield, IconSliders, IconTrash, IconUser, IconX,
} from '../../ui/icons.js'
import { CopyButton, useToast } from '../../ui/kit.js'
import { Shell } from '../../ui/Shell.js'
import { Link, href, navigate } from '../../lib/router.js'

type Tab = 'overview' | 'desk' | 'website' | 'users' | 'orgs' | 'invites' | 'audit' | 'system'

const TABS: { id: Tab; label: string; needs: Permission; Icon: (p: { size?: number }) => ReactElement }[] = [
  { id: 'overview', label: 'Overview', needs: 'overview.read', Icon: IconGrid },
  { id: 'desk', label: 'Service desk', needs: 'desk.read', Icon: IconInbox },
  { id: 'website', label: 'Website', needs: 'site.read', Icon: IconGlobe },
  { id: 'users', label: 'Users', needs: 'users.read', Icon: IconUser },
  { id: 'orgs', label: 'Organizations', needs: 'users.read', Icon: IconGrid },
  { id: 'invites', label: 'Invitations', needs: 'invites.read', Icon: IconKey },
  { id: 'audit', label: 'Audit log', needs: 'audit.read', Icon: IconNote },
  { id: 'system', label: 'System', needs: 'overview.read', Icon: IconSliders },
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
          {tab === 'system' && perms.has('overview.read') ? <System canWrite={perms.has('settings.write')} /> : null}
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
  // A new server (only its owner so far) opens the setup wizard once (A2).
  const [wizard, setWizard] = useState(false)
  // Cards below load their own settings; the wizard changes them, so they reload after it.
  const [epoch, setEpoch] = useState(0)
  useEffect(() => { if (data && canWrite && data.users <= 1 && !wizardDone()) setWizard(true) }, [data?.users])

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
          <SetupChecklist data={data} onGo={onGo} onWizard={canWrite ? () => setWizard(true) : undefined} />
          {wizard ? <SetupWizard data={data} onClose={() => { setWizard(false); setEpoch((n) => n + 1); void reload() }} onInvite={() => onGo('invites')} /> : null}
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
                <h2 id="reg-title">Registration</h2>
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
            <ProfileCard key={`p${epoch}`} canWrite={canWrite} />
            <PolicyCard key={`y${epoch}`} canWrite={canWrite} missing={data.policyGapUsers} onGo={() => onGo('users')} />

            <div className="admin-card">
              <div className="admin-card-head"><span className="dot dot-ok" /><h2>Server</h2></div>
              <p className="big">Running</p>
              <p className="muted small">Version {data.version} · up {Math.floor(data.uptimeSeconds / 3600)} h {Math.floor((data.uptimeSeconds % 3600) / 60)} min · server time {when(data.serverTime)}</p>
            </div>

            <UpdateCard />
          </div>
        </>
      )}
    </Section>
  )
}

/** What a new server still needs, from what the server can see. Gone once
 *  everything is done. */
function SetupChecklist({ data, onGo, onWizard }: { data: AdminOverview; onGo: (t: Tab) => void; onWizard?: (() => void) | undefined }) {
  const [extra, setExtra] = useState<{ profile: boolean; twoFactor: boolean } | null>(null)
  useEffect(() => {
    void (async () => {
      try {
        const t = await session.token()
        const [settings, me] = await Promise.all([api.admin.settings(t), api.me(t)])
        setExtra({ profile: Boolean(settings.profile.supportEmail || settings.profile.supportUrl), twoFactor: me.twoFactor.enabled })
      } catch { /* the checklist waits */ }
    })()
  }, [])
  if (!extra) return null
  const backupOk = data.lastBackup?.at ? Date.now() - Date.parse(data.lastBackup.at) < 36 * 3_600_000 : false
  const steps = [
    { done: extra.twoFactor, text: 'Turn on two-factor sign-in for your own account', go: <Link to={href({ name: 'settings', tab: 'security' })} className="link">Security settings</Link> },
    { done: extra.profile, text: 'Give the server a name and a support address', go: <a className="link" href="#profile-title">Name and support ↓</a> },
    { done: data.mail, text: 'Set up mail, so invitations and sign-in notices are emailed', go: <span className="muted">SMTP_HOST in .env — docs/configuration.md</span> },
    { done: backupOk, text: 'Have a server backup in the last day, and keep the passphrase off the server', go: <span className="muted">BACKUP_PASSPHRASE — docs/INSTALL.md</span> },
    { done: data.registration !== 'open' && !data.registrationForcedOpen, text: 'Keep registration closed or invite-only', go: <a className="link" href="#reg-title">Registration ↓</a> },
    { done: data.users > 1, text: 'Invite your first people', go: <button className="link" onClick={() => onGo('invites')}>Invitations</button> },
  ]
  const left = steps.filter((x) => !x.done).length
  if (left === 0) return null
  return (
    <section className="admin-card admin-checklist" aria-labelledby="setup-title">
      <div className="admin-card-head"><span className="dot dot-warn" /><h2 id="setup-title">Finish setting up</h2><span className="muted small">{left} of {steps.length} left</span>
        {onWizard ? <button className="btn btn-ghost btn-sm" onClick={onWizard}>Step by step…</button> : null}</div>
      <ul>
        {steps.map((x) => (
          <li key={x.text} className={x.done ? 'gs-done' : ''}>
            <span className="gs-mark" aria-hidden="true">{x.done ? <IconCheck size={13} /> : null}</span>
            <span>{x.text}{x.done ? <span className="visually-hidden"> (done)</span> : <> — {x.go}</>}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Whether a newer release is out, and how to upgrade. */
function UpdateCard() {
  const [u, setU] = useState<UpdateStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const load = async (refresh = false) => {
    setBusy(true)
    try { setU(await api.admin.update(await session.token(), refresh)) } catch { /* the card stays quiet */ } finally { setBusy(false) }
  }
  useEffect(() => { void load() }, [])
  if (!u) return null
  return (
    <div className={`admin-card ${u.newer ? 'card-warn' : ''}`}>
      <div className="admin-card-head"><span className={`dot ${u.newer ? 'dot-warn' : u.enabled && !u.error ? 'dot-ok' : 'dot-muted'}`} /><h2>Updates</h2></div>
      {!u.enabled ? (
        <><p className="big">Not checked</p><p className="muted small">Update checks are off on this server (UPDATE_CHECK=false).</p></>
      ) : u.newer ? (
        <>
          <p className="big">{u.latest} is available</p>
          <p className="muted small">You run {u.current}. To upgrade, run the installer again on the server (<code>sh deploy/install.sh</code>) — your data and settings are kept. See docs/INSTALL.md → Upgrading.</p>
          {u.url ? <p className="small"><a href={u.url} target="_blank" rel="noopener noreferrer">Release notes</a></p> : null}
        </>
      ) : (
        <>
          <p className="big">{u.error ? 'Unknown' : u.latest ? 'Up to date' : 'Unknown'}</p>
          <p className="muted small">{u.error ?? (u.current === 'dev' ? `A development build. Latest release: ${u.latest ?? 'none'}.` : `You run ${u.current}, the latest release.`)}</p>
        </>
      )}
      {u.enabled ? <p className="muted small">{u.checkedAt ? `Checked ${ago(u.checkedAt)}. ` : ''}<button className="link" disabled={busy} onClick={() => void load(true)}>Check now</button></p> : null}
    </div>
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
      if (await run(toast, (t) => api.admin.setProfile(t, form), 'Name, support contact and branding saved')) { setSaved(form); refreshInstance() }
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
      <div className="grid-2">
        <div className="field">
          <span className="field-label" id="pf-accent">Accent colour</span>
          <div className="accent-swatches" role="radiogroup" aria-labelledby="pf-accent">
            {ACCENT_CHOICES.map(([key, colour, name]) => (
              <button key={key || 'default'} type="button" role="radio" aria-checked={form.accent === key} aria-label={name} title={name} disabled={!canWrite}
                      className="accent-swatch" style={{ background: colour }}
                      onClick={() => { setForm({ ...form, accent: key }); applyBranding({ accent: key }) }} />
            ))}
          </div>
          <p className="hint">Buttons, links and highlights, for everyone on this server. Each choice is readable in light and dark.</p>
        </div>
        <div className="field">
          <label htmlFor="pf-logo">Logo (PNG, JPEG or WebP, up to 48 KB)</label>
          <div className="logo-row">
            {form.logo ? <img className="logo-preview" src={form.logo} alt="Current logo" /> : null}
            <input id="pf-logo" type="file" accept="image/png,image/jpeg,image/webp" disabled={!canWrite} onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (!file) return
              if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { toast('Use a PNG, JPEG or WebP image.', 'error'); return }
              if (file.size > 48 * 1024) { toast('That image is larger than 48 KB. Use a smaller one.', 'error'); return }
              const reader = new FileReader()
              reader.onload = () => setForm((f) => (f ? { ...f, logo: String(reader.result) } : f))
              reader.readAsDataURL(file)
            }} />
            {form.logo && canWrite ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => setForm({ ...form, logo: '' })}>Remove</button> : null}
          </div>
          <p className="hint">Shown beside the server name on the sign-in page and at the top of the app.</p>
        </div>
      </div>
      {canWrite ? <div className="settings-actions"><button className="btn btn-primary btn-sm" type="submit" disabled={!dirty}>Save</button></div> : null}
    </form>
  )
}

const ACCENT_CHOICES: [string, string, string][] = [
  ['', '#4f46e5', 'Indigo (default)'], ['blue', '#1d4ed8', 'Blue'], ['teal', '#0f766e', 'Teal'], ['green', '#15803d', 'Green'],
  ['orange', '#c2410c', 'Orange'], ['rose', '#be123c', 'Rose'], ['slate', '#334155', 'Slate'],
]
const IDLE_CHOICES: (number | null)[] = [null, 1, 5, 15, 30, 60, 240]
const SESSION_CHOICES: (number | null)[] = [null, 1, 7, 14, 30]
const ACTIVITY_CHOICES = [30, 90, 180, 365]
const AUDIT_CHOICES = [90, 365, 730, 1825]
const days = (n: number) => (n % 365 === 0 ? (n === 365 ? '1 year' : `${n / 365} years`) : n === 1 ? '1 day' : `${n} days`)

/** Server-wide rules for every account (G1, G3, G7). */
function PolicyCard({ canWrite, missing, onGo }: { canWrite: boolean; missing: number; onGo: () => void }) {
  const toast = useToast()
  const [form, setForm] = useState<ServerPolicy | null>(null)
  const [saved, setSaved] = useState<ServerPolicy | null>(null)
  // The list as typed, so a new empty line survives until something is on it.
  const [networksText, setNetworksText] = useState<string | null>(null)
  useEffect(() => {
    void (async () => {
      try { const s = await api.admin.settings(await session.token()); setForm(s.policy); setSaved(s.policy) } catch { /* says loading */ }
    })()
  }, [])
  if (!form) return <div className="admin-card admin-card-wide"><div className="admin-card-head"><h2>Policies</h2></div><p className="muted small">Loading…</p></div>
  const dirty = JSON.stringify(form) !== JSON.stringify(saved)
  const shorter = saved && (form.activityDays < saved.activityDays || form.auditDays < saved.auditDays)
  const strict = saved?.requireTwoFactor || (saved?.minPasswordScore ?? 0) > 0
  const pick = <K extends keyof ServerPolicy>(k: K, parse: (v: string) => ServerPolicy[K]) =>
    (e: React.ChangeEvent<HTMLSelectElement>) => setForm({ ...form, [k]: parse(e.target.value) })
  const orNull = (v: string) => (v === '' ? null : Number(v))
  return (
    <form className="admin-card admin-card-wide" aria-labelledby="policy-title" onSubmit={async (e) => {
      e.preventDefault()
      if (await run(toast, (t) => api.admin.setPolicy(t, form), 'Policies saved')) setSaved(form)
    }}>
      <div className="admin-card-head"><span className={`dot ${strict ? 'dot-ok' : 'dot-muted'}`} /><h2 id="policy-title">Policies</h2></div>
      <p className="muted small">Apply to every account on this server. Nobody is locked out by a policy: an account that misses one is told what to do and marked in Users. The password rule is checked by each person&apos;s app — the server never sees a password.</p>
      <label className="check">
        <input type="checkbox" disabled={!canWrite} checked={form.requireTwoFactor} onChange={(e) => setForm({ ...form, requireTwoFactor: e.target.checked })} />
        <span>Require two-factor sign-in</span>
      </label>
      <div className="grid-3">
        <div className="field">
          <label htmlFor="pol-score">Weakest master password</label>
          <select id="pol-score" disabled={!canWrite} value={form.minPasswordScore} onChange={pick('minPasswordScore', Number)}>
            {STRENGTH_LABELS.map((l, i) => <option key={l} value={i}>{i === 0 ? 'Any' : l}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="pol-idle">Longest auto-lock</label>
          <select id="pol-idle" disabled={!canWrite} value={form.maxIdleMinutes ?? ''} onChange={pick('maxIdleMinutes', orNull)}>
            {IDLE_CHOICES.map((m) => <option key={m ?? 0} value={m ?? ''}>{m ? describeMinutes(m) : 'Each person chooses'}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="pol-session">Sign in again after</label>
          <select id="pol-session" disabled={!canWrite} value={form.sessionDays ?? ''} onChange={pick('sessionDays', orNull)}>
            {SESSION_CHOICES.map((d) => <option key={d ?? 0} value={d ?? ''}>{d ? days(d) : 'Never, while used'}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="pol-activity">Keep account activity for</label>
          <select id="pol-activity" disabled={!canWrite} value={form.activityDays} onChange={pick('activityDays', Number)}>
            {ACTIVITY_CHOICES.map((d) => <option key={d} value={d}>{days(d)}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="pol-audit">Keep audit and organization logs for</label>
          <select id="pol-audit" disabled={!canWrite} value={form.auditDays} onChange={pick('auditDays', Number)}>
            {AUDIT_CHOICES.map((d) => <option key={d} value={d}>{days(d)}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="pol-links">Share links</label>
          <select id="pol-links" disabled={!canWrite} value={form.shareLinks ? String(form.shareLinkMaxDays) : 'off'}
                  onChange={(e) => setForm({ ...form, shareLinks: e.target.value !== 'off', shareLinkMaxDays: e.target.value === 'off' ? form.shareLinkMaxDays : Number(e.target.value) })}>
            <option value="30">Allowed, up to 30 days</option>
            <option value="7">Allowed, up to 7 days</option>
            <option value="1">Allowed, up to 1 day</option>
            <option value="off">Turned off</option>
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="pol-networks">Allow sign-in only from (one address or range per line; empty for anywhere)</label>
        <textarea id="pol-networks" rows={3} className="mono" disabled={!canWrite} placeholder={'203.0.113.0/24\n2001:db8::/32'}
                  value={networksText ?? form.allowedNetworks.join('\n')}
                  onChange={(e) => { setNetworksText(e.target.value); setForm({ ...form, allowedNetworks: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) }) }} />
        <p className="hint">Owners can always sign in, so a wrong list can be fixed. Devices outside the list are signed out within 15 minutes. Your own address must be in the list.</p>
      </div>
      {shorter ? <p className="alert alert-warn"><IconAlert size={16} /><span>Saving deletes log entries older than the new period. That cannot be undone.</span></p> : null}
      {missing > 0 ? <p className="muted small">{missing === 1 ? '1 account does' : `${missing} accounts do`} not meet these yet. <button type="button" className="link" onClick={onGo}>See Users</button></p> : null}
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
                      {u.policyGap && !u.disabled ? <span className="pill pill-warn" title="Does not meet the server policies yet">Misses policy</span> : null}
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
                            {!u.disabled ? (
                              <button className="btn btn-secondary btn-sm" aria-label={`Offboard ${u.label || 'this account'}`} onClick={async () => {
                                if (!window.confirm(`Offboard ${u.label || 'this account'}? They are disabled, signed out everywhere, and removed from every organization. Shared passwords they could see are listed for their colleagues to change.`)) return
                                if (await run(toast, (t) => api.admin.offboard(t, u.userId), 'Offboarded: disabled, signed out, removed from organizations')) await reload()
                              }}>Offboard</button>
                            ) : null}
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

/** "email, name" per line — what a spreadsheet column pastes as. */
export function parsePeople(text: string): { people: { email: string; name?: string }[]; problems: string[] } {
  const people: { email: string; name?: string }[] = []
  const problems: string[] = []
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim()
    if (!line || /^email\b/i.test(line)) return
    const [email = '', ...rest] = line.split(/[,;\t]/).map((x) => x.trim())
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { problems.push(`Line ${i + 1}: "${email}" is not an email address`); return }
    const name = rest.join(' ').trim()
    people.push({ email, ...(name ? { name } : {}) })
  })
  return { people, problems }
}

function BulkInvite({ canRoles, onDone }: { canRoles: boolean; onDone: () => Promise<void> }) {
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [days, setDays] = useState(7)
  const [role, setRole] = useState<Role>('user')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<Awaited<ReturnType<typeof api.admin.bulkInvite>> | null>(null)
  const parsed = parsePeople(text)

  async function send(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const res = await api.admin.bulkInvite(await session.token(), parsed.people, days, role)
      setDone(res); setText('')
      await onDone()
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not send the invitations.', 'error')
    } finally {
      setBusy(false)
    }
  }

  if (!open) return <p className="small"><button className="link" onClick={() => setOpen(true)}>Invite many people at once…</button></p>
  return (
    <form className="admin-card bulk-invite" onSubmit={send} aria-labelledby="bulk-title">
      <h2 id="bulk-title">Invite many people</h2>
      <div className="field">
        <label htmlFor="bulk-people">One person per line: email, then a name you will recognise (optional)</label>
        <textarea id="bulk-people" rows={6} spellCheck={false} placeholder={'asha@example.com, Asha (finance)\nravi@example.com, Ravi'} value={text} onChange={(e) => setText(e.target.value)} />
        <p className="hint">{parsed.people.length} {parsed.people.length === 1 ? 'person' : 'people'}{parsed.problems.length ? ` · ${parsed.problems.length} line${parsed.problems.length === 1 ? '' : 's'} to fix` : ''}. Pasting a column from a spreadsheet works.</p>
        {parsed.problems.slice(0, 5).map((p) => <p key={p} className="hint hint-error">{p}</p>)}
      </div>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="bulk-days">Expires after</label>
          <select id="bulk-days" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[1, 3, 7, 14, 30].map((d) => <option key={d} value={d}>{d} day{d > 1 ? 's' : ''}</option>)}
          </select>
        </div>
        {canRoles ? (
          <div className="field">
            <label htmlFor="bulk-role">Everyone starts as</label>
            <select id="bulk-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {(['user', 'viewer', 'support', 'marketing', 'admin'] as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </select>
          </div>
        ) : null}
      </div>
      {done ? (
        <div className="issued">
          {done.warning ? <p className="alert alert-warn"><IconAlert size={16} /><span>{done.warning}</span></p> : null}
          <p><strong>{done.results.filter((r) => r.emailed).length} of {done.results.length} emailed.</strong> {done.results.some((r) => !r.emailed) ? 'Send the others their code yourself — each is shown once:' : ''}</p>
          {done.results.some((r) => r.code) ? (
            <>
              <ul className="bulk-codes">{done.results.filter((r) => r.code).map((r) => <li key={r.email}><span>{r.email}</span> <code>{r.code}</code></li>)}</ul>
              <CopyButton value={done.results.filter((r) => r.code).map((r) => `${r.email},${r.code}`).join('\n')} label="Codes" />
            </>
          ) : null}
        </div>
      ) : null}
      <div className="settings-actions">
        <button type="button" className="btn btn-secondary" onClick={() => { setOpen(false); setDone(null) }}>Close</button>
        <button className="btn btn-primary" type="submit" disabled={busy || !parsed.people.length || parsed.problems.length > 0}>
          {busy ? <><span className="spinner" />Sending…</> : `Invite ${parsed.people.length || ''}`.trim()}
        </button>
      </div>
    </form>
  )
}

function Invites({ canWrite, canRoles }: { canWrite: boolean; canRoles: boolean }) {
  const toast = useToast()
  const [role, setRole] = useState<Role>('user')
  const { data, error, reload } = useAdminData(loadInvites)
  const [label, setLabel] = useState('')
  const [days, setDays] = useState(7)
  const [email, setEmail] = useState('')
  const [issued, setIssued] = useState<{ code: string; label: string; expiresAt: string; emailedTo?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [resending, setResending] = useState<{ invite: AdminInvite; email: string } | null>(null)

  async function create(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const res = await api.admin.createInvite(await session.token(), label.trim(), days, role, email.trim())
      setIssued({ code: res.code, label: res.invite.label, expiresAt: res.invite.expiresAt, ...(res.emailed ? { emailedTo: email.trim() } : {}) })
      if (res.warning) toast(res.warning, 'error')
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

      {canWrite ? <BulkInvite canRoles={canRoles} onDone={reload} /> : null}

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
                      <button className="btn btn-ghost btn-sm" aria-label={`Send the invitation for ${i.label} again`} onClick={() => setResending({ invite: i, email: '' })}>Send again</button>
                    ) : null}
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
      {resending ? (
        <form className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="rs-title" onSubmit={async (e) => {
          e.preventDefault()
          const r = resending
          await run(toast, async (t) => {
            const res = await api.admin.resendInvite(t, r.invite.id, r.email.trim())
            setIssued({ code: res.code, label: res.invite.label, expiresAt: res.invite.expiresAt, ...(res.emailed ? { emailedTo: r.email.trim() } : {}) })
          }, 'Sent again with a fresh code; the old one no longer works')
          setResending(null); await reload()
        }}>
          <div className="modal">
            <h2 id="rs-title">Send the invitation for {resending.invite.label} again</h2>
            <p className="muted">Vault keeps only a fingerprint of each code, so a fresh code replaces the old one, valid for 7 days. The old code stops working.</p>
            <label htmlFor="rs-email" className="field-label">Email it to (optional)</label>
            <input id="rs-email" type="email" autoFocus placeholder="Leave empty to copy the code yourself" value={resending.email} onChange={(e) => setResending({ ...resending, email: e.target.value })} />
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setResending(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary">Send again</button>
            </div>
          </div>
        </form>
      ) : null}
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
  const toast = useToast()
  const { data, error, reload } = useAdminData(loadAudit)
  return (
    <Section title="Audit log" sub="Every admin action, kept as long as the audit retention policy says. Written before the action runs, so nothing here happens unrecorded."
             actions={<>
               {(['csv', 'json'] as const).map((f) => (
                 <button key={f} className="btn btn-secondary btn-sm" onClick={async () => {
                   try { download(`vault-audit-${new Date().toISOString().slice(0, 10)}.${f}`, await api.admin.auditExport(await session.token(), f), f === 'csv' ? 'text/csv' : 'application/json') }
                   catch (err) { toast(err instanceof Error ? err.message : 'Could not export.', 'error') }
                 }}><IconDownload size={15} />{f.toUpperCase()}</button>
               ))}
               <button className="btn btn-secondary btn-sm" onClick={() => void reload()}><IconRefresh size={15} />Refresh</button>
             </>}>
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
