// The operator's panel. It manages accounts and the service; it cannot read a
// vault, and it never sees an address — the server holds neither in a form
// that could be shown. Accounts are told apart by the label on the invitation
// that created them, or one set here.
//
// Every action is checked again by the server. Hiding this panel from
// non-admins is a courtesy, not the control.

import { type ReactElement, useEffect, useState } from 'react'

import {
  type AdminInvite,
  type Edition,
  type Features,
  type AdminOverview,
  type InstanceProfile,
  type UpdateStatus,
  type Permission,
  type RegistrationMode,
  type Role,
  type ServerPolicy,
  api,
} from '../../lib/api.js'
import { STRENGTH_LABELS, describeMinutes } from '@vault/core'
import { ErrorBox, ROLE_LABELS, Section, ago, run, useAdminData, when } from './common.js'
import { Desk } from './Desk.js'
import { Users } from './Users.js'
import { Audit } from './AuditLog.js'
import { NeedsAttention, Reports } from './Insights.js'
import { TenantPanel } from './Tenants.js'
import { Website } from './Website.js'
import { System } from './System.js'
import { SetupWizard, wizardDone } from './SetupWizard.js'
import { applyBranding, refresh as refreshInstance, useEdition, useInstance } from '../../lib/instance.js'
import * as session from '../../lib/session.js'
import {
  IconAlert, IconCheck, IconGlobe, IconInbox, IconGrid, IconKey, IconNote,
  IconPlus, IconPulse, IconRefresh, IconSliders, IconTrash, IconUser,
} from '../../ui/icons.js'
import { CopyButton, useToast } from '../../ui/kit.js'
import { Link, href } from '../../lib/router.js'

type Tab = 'overview' | 'desk' | 'website' | 'users' | 'orgs' | 'invites' | 'audit' | 'reports' | 'system'

/** `feature`: the edition feature a tab needs (decisions/0030). A personal
 *  Vault has one account, so no users list, invitations or organizations. */
const TABS: { id: Tab; label: string; needs: Permission; feature?: keyof Features; Icon: (p: { size?: number }) => ReactElement }[] = [
  { id: 'overview', label: 'Overview', needs: 'overview.read', Icon: IconGrid },
  { id: 'desk', label: 'Service desk', needs: 'desk.read', feature: 'serviceDesk', Icon: IconInbox },
  { id: 'website', label: 'Website', needs: 'site.read', feature: 'website', Icon: IconGlobe },
  { id: 'users', label: 'Users', needs: 'users.read', feature: 'invitations', Icon: IconUser },
  { id: 'orgs', label: 'Organizations', needs: 'users.read', feature: 'organizations', Icon: IconGrid },
  { id: 'invites', label: 'Invitations', needs: 'invites.read', feature: 'invitations', Icon: IconKey },
  { id: 'audit', label: 'Audit log', needs: 'audit.read', Icon: IconNote },
  { id: 'reports', label: 'Reports', needs: 'audit.read', feature: 'invitations', Icon: IconPulse },
  { id: 'system', label: 'System', needs: 'overview.read', Icon: IconSliders },
]

export { ROLE_LABELS }

export type ServerTab = Tab
export const SERVER_TABS = TABS

/** The server sections this account may open, in this edition. */
export function serverTabs(state: session.Unlocked, features: Features, edition: Edition = 'hosted', companiesInvited = false): typeof TABS {
  const perms = new Set<Permission>(state.permissions ?? [])
  // A business Vault's people are managed under the company (decisions/0032).
  const company = edition === 'business' ? new Set<Tab>(['users', 'invites', 'orgs']) : new Set<Tab>()
  return TABS.filter((t) => perms.has(t.needs) && (!t.feature || features[t.feature]) && !company.has(t.id))
    // A hosted server's organizations are its tenants (decisions/0033).
    .map((t) => (companiesInvited && t.id === 'orgs' ? { ...t, label: 'Tenants' } : t))
}

/** One server section, inside the admin console (decisions/0031). */
export function ServerSection({ state, tab, onGo }: { state: session.Unlocked; tab: Tab; onGo: (t: Tab) => void }) {
  const perms = new Set<Permission>(state.permissions ?? [])
  return (
    <>
      {tab === 'overview' && perms.has('overview.read') ? <Overview onGo={onGo} canWrite={perms.has('settings.write')} /> : null}
      {tab === 'desk' && perms.has('desk.read') ? <Desk selfId={state.userId} canWrite={perms.has('desk.write')} canApprove={perms.has('invites.write')} canReset={perms.has('users.write')} /> : null}
      {tab === 'website' && perms.has('site.read') ? <Website canWrite={perms.has('site.write')} canPublish={perms.has('site.publish')} /> : null}
      {tab === 'users' && perms.has('users.read') ? <Users selfId={state.userId} canWrite={perms.has('users.write')} canRoles={perms.has('roles.write')} /> : null}
      {tab === 'orgs' && perms.has('users.read') ? <AdminOrgs canWrite={perms.has('users.write')} canInvite={perms.has('invites.write')} /> : null}
      {tab === 'invites' && perms.has('invites.read') ? <><VaultRequests canWrite={perms.has('invites.write')} /><Invites canWrite={perms.has('invites.write')} canRoles={perms.has('roles.write')} /></> : null}
      {tab === 'audit' && perms.has('audit.read') ? <Audit /> : null}
      {tab === 'reports' && perms.has('audit.read') ? <Reports /> : null}
      {tab === 'system' && perms.has('overview.read') ? <System canWrite={perms.has('settings.write')} canTokens={perms.has('roles.write')} /> : null}
    </>
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

  const { features } = useEdition()
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
          {features.invitations ? <NeedsAttention onGo={onGo} /> : null}
          {wizard ? <SetupWizard data={data} onClose={() => { setWizard(false); setEpoch((n) => n + 1); void reload() }} onInvite={() => onGo('invites')} /> : null}
          <div className="stats">
            {features.invitations ? <Stat label="Accounts" value={data.users} note={data.disabledUsers ? `${data.disabledUsers} disabled` : 'all active'} onClick={() => onGo('users')} /> : null}
            <Stat label="Encrypted items" value={data.entries} note="across every vault" />
            <Stat label="Active sessions" value={data.activeSessions} note="signed-in devices" />
            {features.invitations ? <Stat label="Open invitations" value={data.activeInvites} note="unused and unexpired" onClick={() => onGo('invites')} /> : null}
            {features.serviceDesk ? <Stat label="Open tickets" value={data.openTickets} note="in the service desk" onClick={() => onGo('desk')} /> : null}
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

            {features.invitations ? <div className="admin-card">
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
            </div> : null}

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
  const { features } = useEdition()
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
    { done: data.mail, text: features.invitations ? 'Set up mail, so invitations and sign-in notices are emailed' : 'Set up mail, so sign-in notices and backup alerts reach you', go: <span className="muted">SMTP_HOST in .env — docs/configuration.md</span> },
    { done: backupOk, text: 'Have a server backup in the last day, and keep the passphrase off the server', go: <span className="muted">BACKUP_PASSPHRASE — docs/INSTALL.md</span> },
    // A personal Vault has no one to invite (decisions/0030).
    ...(features.invitations ? [
      { done: data.registration !== 'open' && !data.registrationForcedOpen, text: 'Keep registration closed or invite-only', go: <a className="link" href="#reg-title">Registration ↓</a> },
      { done: data.users > 1, text: 'Invite your first people', go: <button className="link" onClick={() => onGo('invites')}>Invitations</button> },
    ] : []),
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
  const instance = useInstance()
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
      <label className="check">
        <input type="checkbox" disabled={!canWrite} checked={form.requireStaffTwoFactor === true} onChange={(e) => setForm({ ...form, requireStaffTwoFactor: e.target.checked })} />
        <span>Staff (owners, admins, support, marketing, viewers) must use two-factor sign-in to open the admin console</span>
      </label>
      <label className="check">
        <input type="checkbox" disabled={!canWrite} checked={form.weeklyDigest !== false} onChange={(e) => setForm({ ...form, weeklyDigest: e.target.checked })} />
        <span>Email owners and admins a weekly summary (sign-ins, and what needs attention){instance?.mail ? <> · <button type="button" className="link" disabled={!canWrite} onClick={async () => {
          try { const r = await api.admin.sendDigest(await session.token()); toast(r.sent ? `Summary sent to ${r.sent} address(es)` : 'Nobody to send it to: owners and admins need an address on file') }
          catch (err) { toast(err instanceof Error ? err.message : 'Could not send it.', 'error') }
        }}>Send one now</button></> : <span className="muted"> (needs mail set up)</span>}</span>
      </label>
      {instance?.sso ? (
        <label className="check">
          <input type="checkbox" disabled={!canWrite} checked={form.requireSso === true} onChange={(e) => setForm({ ...form, requireSso: e.target.checked })} />
          <span>Require single sign-on with {instance.sso.name} (owners can still use their master password alone, so a broken provider cannot lock everyone out)</span>
        </label>
      ) : null}
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

/** Requests for a vault from accounts that have none (decisions/0037).
 *  Approving emails the person, who then creates their vault. */
function VaultRequests({ canWrite }: { canWrite: boolean }) {
  const toast = useToast()
  const [rows, setRows] = useState<{ userId: string; email: string; note: string; requestedAt: string }[] | null>(null)
  const load = async () => { try { setRows((await api.admin.vaultRequests(await session.token())).requests) } catch { setRows([]) } }
  useEffect(() => { void load() }, [])
  if (!rows) return null
  return (
    <section className="admin-card admin-card-wide" aria-labelledby="vault-requests-title">
      <div className="admin-card-head"><span className={`dot ${rows.length ? 'dot-warn' : 'dot-muted'}`} /><h2 id="vault-requests-title">Requests for a vault</h2>{rows.length ? <span className="pill pill-warn">{rows.length}</span> : null}</div>
      <p className="muted small">People who created an account and asked for a vault, while registration is by invitation. Approving emails them; they then create the vault with their own master password.</p>
      {rows.length ? (
        <ul className="device-list">
          {rows.map((r) => (
            <li key={r.userId} className="device-row vault-request">
              <div className="device-text"><span className="device-name">{r.email || 'Address unreadable'}</span>
                <span className="muted small">asked {when(r.requestedAt)}{r.note ? ` · “${r.note}”` : ''}</span></div>
              {canWrite ? (
                <div className="device-actions">
                  <button className="btn btn-secondary btn-sm" onClick={async () => { if (await run(toast, (t) => api.admin.decideVaultRequest(t, r.userId, false), 'Request declined')) await load() }}>Decline</button>
                  <button className="btn btn-primary btn-sm" aria-label={`Approve ${r.email}`} onClick={async () => { if (await run(toast, (t) => api.admin.decideVaultRequest(t, r.userId, true), `Approved; ${r.email} was emailed`)) await load() }}>Approve</button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : <p className="muted small">No requests waiting.</p>}
    </section>
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

const loadOrgs = (t: string) => api.admin.orgs(t)

function AdminOrgs({ canWrite, canInvite }: { canWrite: boolean; canInvite: boolean }) {
  const toast = useToast()
  const { data, error, reload } = useAdminData(loadOrgs)
  // A hosted server's companies are its tenants, invited by its operator (decisions/0033).
  const hosted = useInstance()?.companiesInvited === true
  const orgs = (data?.orgs ?? []).filter((o) => !hosted || o.kind !== 'direct')
  const directs = hosted ? (data?.orgs ?? []).length - orgs.length : 0
  const [company, setCompany] = useState('')
  const [email, setEmail] = useState('')
  const [issued, setIssued] = useState<{ code: string; label: string; expiresAt: string; emailed: boolean } | null>(null)
  const [managing, setManaging] = useState<string | null>(null)
  return (
    <Section title={hosted ? 'Tenants' : 'Organizations'} sub={hosted
      ? 'The companies on this server. Each runs itself from its own Admin console; names, collections and items are encrypted for their members, and nobody here can open them.'
      : 'Every organization on this server, by counts. Names, collections and items are encrypted for their members; nobody here can open them.'}>
      <ErrorBox error={error} />
      {hosted && canInvite ? (
        <form className="admin-card company-invite" onSubmit={async (e) => {
          e.preventDefault()
          try {
            const res = await api.admin.companyInvite(await session.token(), company.trim(), email.trim())
            setIssued({ code: res.code, label: res.invite.label, expiresAt: res.invite.expiresAt, emailed: res.emailed }); setCompany(''); setEmail('')
          } catch (err) { toast(err instanceof Error ? err.message : 'Could not create the invitation.', 'error') }
        }}>
          <div className="admin-card-head"><h2>Invite a company</h2></div>
          <p className="muted small">The person who signs up with the code may create one company, and runs it from their own Admin console: its people, collections and policies.</p>
          <div className="inline-form">
            <input required maxLength={80} placeholder="Company, e.g. Acme Corp" aria-label="Company name" value={company} onChange={(e) => setCompany(e.target.value)} />
            <input type="email" placeholder="Their email (optional)" aria-label="Their email" value={email} onChange={(e) => setEmail(e.target.value)} />
            <button className="btn btn-primary btn-sm" type="submit" disabled={!company.trim()}>Create invitation</button>
          </div>
          {issued ? (
            <div className="issued company-code">
              <p><strong>Invitation for {issued.label}</strong> — expires {when(issued.expiresAt)}. {issued.emailed ? 'Emailed, with a link. ' : ''}This code is shown once.</p>
              <div className="recovery-key"><code>{issued.code}</code><CopyButton value={issued.code} label="Company invitation code" /></div>
              <button className="link" onClick={() => setIssued(null)}>Done</button>
            </div>
          ) : null}
        </form>
      ) : null}
      {!data ? <div className="skeletons"><div className="skeleton" /></div> : orgs.length === 0 ? <div className="empty"><h3>{hosted ? 'No tenants yet' : 'No organizations yet'}</h3><p>{hosted ? 'Invite a company above.' : 'Members create them from Account menu → My organizations.'}</p></div> : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Name (as typed by its creator)</th><th className="num">Members</th>{hosted ? <th>Seats</th> : null}<th className="num">Collections</th><th className="num">Items</th><th>Policies</th><th>Created</th>{canWrite || hosted ? <th aria-label="Actions" /> : null}</tr></thead>
            <tbody>
              {orgs.map((o) => (
                <tr key={o.id}>
                  <td>{o.hint || <span className="muted">Unnamed</span>}{o.suspended ? <span className="pill pill-danger"> Suspended</span> : null}{o.domains?.some((d) => d.verifiedAt) ? <span className="pill pill-ok" title={o.domains.filter((d) => d.verifiedAt).map((d) => d.domain).join(', ')}> Domain verified</span> : null}{o.rotationDue ? <span className="pill pill-danger" title="A collection key should be rotated by one of its managers">{o.rotationDue} key rotation due</span> : null}</td>
                  <td className="num" title={`${o.awaiting} awaiting confirmation, ${o.pending} invited`}>{o.members}{o.awaiting + o.pending ? <span className="muted"> +{o.awaiting + o.pending}</span> : null}</td>
                  {hosted ? <td>{o.seatLimit === null || o.seatLimit === undefined ? <span className="muted">no limit</span> : `${o.members + o.awaiting + o.pending} / ${o.seatLimit}`}</td> : null}
                  <td className="num">{o.collections}</td>
                  <td className="num">{o.items}</td>
                  <td>{[o.policies.requireTwoFactor && '2FA', o.policies.minPasswordScore > 0 && 'password', o.policies.maxIdleMinutes && `${o.policies.maxIdleMinutes} min lock`].filter(Boolean).join(' · ') || <span className="muted">none</span>}</td>
                  <td>{when(o.createdAt)}</td>
                  {canWrite || hosted ? <td><div className="row-actions">{hosted ? <button className="btn btn-secondary btn-sm" aria-label={`Manage ${o.hint || 'company'}`} onClick={() => setManaging(o.id)}>Manage</button> : null}{canWrite ? <button className="icon-btn icon-danger" aria-label={`Delete ${o.hint}`} title="Delete organization" onClick={async () => {
                    if (!window.confirm(`Delete "${o.hint}" and everything in it — its collections and their items — for all its members? This cannot be undone and is recorded in the audit log.`)) return
                    if (await run(toast, (t) => api.admin.deleteOrg(t, o.id), 'Organization deleted')) await reload()
                  }}><IconTrash size={15} /></button> : null}</div></td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {managing ? <TenantPanel id={managing} canWrite={canWrite} onClose={() => setManaging(null)} onChanged={reload} /> : null}
      {directs ? <p className="muted small">Not listed: {directs} private share{directs === 1 ? '' : 's'} between two people.</p> : null}
    </Section>
  )
}

export type { AdminOverview }
