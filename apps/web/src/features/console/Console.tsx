// The admin console (decisions/0031): everything an administrator does, kept
// apart from their own vault. A scope picker chooses what is being managed:
// the server (staff roles) or one organization (its owners and admins). Each
// scope has its own sections; members of an organization never come here.

import { useEffect, type ReactElement } from 'react'

import type { Edition, Features } from '../../lib/api.js'
import { useEdition, useInstance } from '../../lib/instance.js'
import { Link, type Route, href, navigate } from '../../lib/router.js'
import * as session from '../../lib/session.js'
import { type Scope, useScopes } from '../../lib/workspace.js'
import { IconAlert, IconPulse, IconFolder, IconGrid, IconNote, IconShield, IconSliders, IconUser, IconUsers } from '../../ui/icons.js'
import { Shell } from '../../ui/Shell.js'
import { type ServerTab, ServerSection, serverTabs } from '../admin/Admin.js'
import { useTeams } from '../orgs/model.js'
import { TeamHealth } from './TeamHealth.js'
import { Activity, Groups, OrgBackup, OrgCollections, OrgMembers, OrgRecovery, PermissionSets, PoliciesForm, useOrgPeople } from '../orgs/Orgs.js'

type ConsoleRoute = Extract<Route, { name: 'console' }>

const ORG_SECTIONS = [
  { id: 'members', label: 'People', Icon: IconUser, intro: 'Everyone in the organization: who is waiting for you to confirm them, who is invited, and inviting more.' },
  { id: 'groups', label: 'Groups', Icon: IconUsers, intro: 'Teams of members, to give collections to several people at once.' },
  { id: 'collections', label: 'Collections', Icon: IconFolder, intro: 'Shared folders, who can open each, and requests for access.' },
  { id: 'health', label: 'Password health', Icon: IconPulse, intro: 'Weak, reused, old and breached passwords in the collections you manage, worked out in this browser.' },
  { id: 'sets', label: 'Permission sets', Icon: IconShield, intro: 'What people may do in a collection: the built-in sets, and your own.' },
  { id: 'policies', label: 'Policies', Icon: IconSliders, intro: 'Rules every member must meet before the collections open for them.' },
  { id: 'activity', label: 'Activity', Icon: IconNote, intro: 'Who did what, for a year. Opening, copying and filling are reported by members’ apps.' },
  { id: 'recovery', label: 'Recovery & backup', Icon: IconShield, intro: 'The recovery key that gives the organization back if every admin is locked out, and an encrypted backup.' },
] as const
type OrgSection = (typeof ORG_SECTIONS)[number]['id']

const scopeKey = (s: Scope) => (s.kind === 'server' ? 'server' : `org:${s.id}`)

export function Console({ state, route }: { state: session.Unlocked; route: ConsoleRoute }) {
  const { scopes: found, loaded } = useScopes(state)
  const { features, edition } = useEdition()
  // A business Vault is its company first; the server second (decisions/0032).
  const scopes = edition === 'business' ? [...found.filter((s) => s.kind === 'org'), ...found.filter((s) => s.kind === 'server')] : found
  const noCompany = edition === 'business' && !found.some((s) => s.kind === 'org') && state.role === 'owner'
  const instance = useInstance()

  const current: Scope | undefined = route.scope === 'server' ? scopes.find((s) => s.kind === 'server')
    : route.scope === 'org' ? scopes.find((s) => s.kind === 'org' && s.id === route.org)
    : undefined

  // No scope in the address, or one this account cannot manage: the first it can.
  useEffect(() => {
    if (!loaded || current || !scopes[0]) return
    const first = scopes[0]
    navigate(href(first.kind === 'server' ? { name: 'console', scope: 'server', section: null } : { name: 'console', scope: 'org', org: first.id, section: null }), { replace: true })
  }, [loaded, current, scopes])

  if (!loaded) return <div className="boot">Loading…</div>
  if (!scopes.length) {
    return (
      <Shell state={state}>
        <main className="settings"><div className="settings-head"><h1>Admin console</h1>
          <p className="alert alert-info"><IconAlert size={16} /><span>There is nothing for you to administer here. Organizations you join are under <strong>My organizations</strong>.</span></p></div></main>
      </Shell>
    )
  }
  if (!current) return <div className="boot">Loading…</div>

  const serverName = instance?.name && instance.name !== 'Vault' ? instance.name : 'This server'
  const choose = (key: string) => {
    const s = scopes.find((x) => scopeKey(x) === key)
    if (s) navigate(href(s.kind === 'server' ? { name: 'console', scope: 'server', section: null } : { name: 'console', scope: 'org', org: s.id, section: null }))
  }

  return (
    <Shell state={state}>
      <div className="admin-layout console-layout">
        <nav className="sidebar" aria-label="Admin console">
          <ScopePicker id="scope" scopes={scopes} current={current} serverName={serverName} onChoose={choose} />
          {current.kind === 'server'
            ? <ServerNav state={state} features={features} edition={edition} section={route.section} />
            : <OrgNav orgId={current.id} section={route.section} />}
          <div className="sidebar-foot">
            <IconShield size={14} /> {current.kind === 'server'
              ? 'You can manage accounts here, but not read them. Vault contents and addresses never reach the server in readable form.'
              : 'You hold this organization’s keys in this browser only. Confirm people by fingerprint, never by email or chat.'}
          </div>
        </nav>
        {/* Below the width where the sidebar shows: the same picker, and the sections as chips. */}
        <div className="console-mobile">
          <ScopePicker id="scope-m" scopes={scopes} current={current} serverName={serverName} onChoose={choose} />
          {current.kind === 'server'
            ? <Chips items={serverTabs(state, features, edition, instance?.companiesInvited === true)} active={serverTabs(state, features, edition, instance?.companiesInvited === true).find((t) => t.id === route.section)?.id ?? serverTabs(state, features, edition, instance?.companiesInvited === true)[0]?.id ?? 'overview'} onGo={(id) => navigate(href({ name: 'console', scope: 'server', section: id }))} />
            : <Chips items={[...ORG_SECTIONS]} active={ORG_SECTIONS.find((t) => t.id === route.section)?.id ?? 'members'} onGo={(id) => navigate(href({ name: 'console', scope: 'org', org: current.id, section: id }))} />}
        </div>
        <main className="admin-main">
          {current.kind === 'server'
            ? <>
                {noCompany ? (
                  <div className="admin-section console-prompt">
                    <p className="alert alert-info"><IconAlert size={16} /><span><strong>Create your company</strong> to invite your people: they join it, you confirm them by fingerprint, and you share collections with them. <Link className="link" to="/app/orgs">Create the company</Link></span></p>
                  </div>
                ) : null}
                <ServerScope state={state} features={features} edition={edition} section={route.section} />
              </>
            : <OrgScope state={state} orgId={current.id} fallbackName={current.name} section={route.section} />}
        </main>
      </div>
    </Shell>
  )
}

function ScopePicker({ id, scopes, current, serverName, onChoose }: { id: string; scopes: Scope[]; current: Scope; serverName: string; onChoose: (key: string) => void }) {
  return (
    <div className="scope-picker">
      <label htmlFor={id} className="small muted">Managing</label>
      {scopes.length > 1 ? (
        <select id={id} value={scopeKey(current)} onChange={(e) => onChoose(e.target.value)}>
          {scopes.map((s) => <option key={scopeKey(s)} value={scopeKey(s)}>{s.kind === 'server' ? `${serverName} (server)` : s.name}</option>)}
        </select>
      ) : <p id={id} className="scope-name">{current.kind === 'server' ? serverName : current.name}</p>}
    </div>
  )
}

function NavList({ items, active, onGo }: { items: { id: string; label: string; Icon: (p: { size?: number }) => ReactElement }[]; active: string; onGo: (id: string) => void }) {
  return (
    <>
      {items.map(({ id, label, Icon }) => (
        <button key={id} className={`side-item ${active === id ? 'side-active' : ''}`} onClick={() => onGo(id)} aria-current={active === id ? 'page' : undefined}>
          <Icon size={16} /><span>{label}</span>
        </button>
      ))}
    </>
  )
}

function ServerNav({ state, features, edition, section }: { state: session.Unlocked; features: Features; edition: Edition; section: string | null }) {
  const tabs = serverTabs(state, features, edition, useInstance()?.companiesInvited === true)
  const active = tabs.find((t) => t.id === section)?.id ?? tabs[0]?.id ?? 'overview'
  const go = (id: string) => navigate(href({ name: 'console', scope: 'server', section: id }))
  return <NavList items={tabs} active={active} onGo={go} />
}

function ServerScope({ state, features, edition, section }: { state: session.Unlocked; features: Features; edition: Edition; section: string | null }) {
  const tabs = serverTabs(state, features, edition, useInstance()?.companiesInvited === true)
  const tab = (tabs.find((t) => t.id === section)?.id ?? tabs[0]?.id ?? 'overview') as ServerTab
  return <ServerSection state={state} tab={tab} onGo={(t) => navigate(href({ name: 'console', scope: 'server', section: t }))} />
}

function OrgNav({ orgId, section }: { orgId: string; section: string | null }) {
  const active = ORG_SECTIONS.find((t) => t.id === section)?.id ?? 'members'
  const go = (id: string) => navigate(href({ name: 'console', scope: 'org', org: orgId, section: id }))
  return <NavList items={[...ORG_SECTIONS]} active={active} onGo={go} />
}

/** The sections as chips, for a phone, where the sidebar is hidden. */
function Chips({ items, active, onGo }: { items: { id: string; label: string }[]; active: string; onGo: (id: string) => void }) {
  return (
    <div className="filter-chips console-chips">
      {items.map(({ id, label }) => <button key={id} className={`chip ${active === id ? 'chip-active' : ''}`} onClick={() => onGo(id)}>{label}</button>)}
    </div>
  )
}

function OrgScope({ state, orgId, fallbackName, section }: { state: session.Unlocked; orgId: string; fallbackName: string; section: string | null }) {
  const teams = useTeams(state.vaultKey)
  const org = teams.orgs.find((o) => o.id === orgId)
  const people = useOrgPeople(org, teams)
  const tab: OrgSection = ORG_SECTIONS.find((t) => t.id === section)?.id ?? 'members'
  const info = ORG_SECTIONS.find((t) => t.id === tab)!

  return (
    <div className="admin-section console-org">
      <div className="settings-head">
        <ol className="crumbs crumbs-admin" aria-label="Breadcrumb">
          <li>Admin console</li>
          <li>{org?.name ?? fallbackName}</li>
          <li aria-current="page">{info.label}</li>
        </ol>
        <h1>{info.label}</h1>
        <p className="muted">{info.intro}</p>
      </div>
      {teams.error ? <p className="alert alert-error"><IconAlert size={16} />{teams.error}</p> : null}
      {!org ? <div className="skeletons"><div className="skeleton" /></div> : (
        <>
          {tab === 'members' ? <OrgMembers org={org} teams={teams} selfId={state.userId} people={people} /> : null}
          {tab === 'groups' ? <Groups org={org} teams={teams} people={people} /> : null}
          {tab === 'collections' ? <OrgCollections org={org} teams={teams} people={people} /> : null}
          {tab === 'health' ? <TeamHealth org={org} teams={teams} /> : null}
          {tab === 'sets' ? <PermissionSets org={org} /> : null}
          {tab === 'policies' ? <section className="settings-card org-card" aria-label={org.name}><PoliciesForm org={org} teams={teams} always /></section> : null}
          {tab === 'activity' ? <section className="settings-card org-card" aria-label={org.name}><Activity org={org} teams={teams} members={people.members} always /></section> : null}
          {tab === 'recovery' ? (
            <section className="settings-card org-card" aria-label={org.name}>
              <div className="settings-card-head"><IconShield size={18} /><h2>Recovery key</h2></div>
              <OrgRecovery org={org} teams={teams} />
              <div className="settings-card-head console-sub"><IconGrid size={18} /><h2>Encrypted backup</h2></div>
              <p className="muted small">A file with every item in the collections you can open, each collection a folder, protected by a password you choose.</p>
              <OrgBackup org={org} teams={teams} />
            </section>
          ) : null}
        </>
      )}
    </div>
  )
}
