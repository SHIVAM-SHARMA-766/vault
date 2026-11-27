// Organizations: your fingerprint, invitations, and — for admins — members
// (with the confirm-by-fingerprint step), invitations and collections with
// who can open them. Items themselves are used from the vault.

import { useEffect, useState } from 'react'

import { fingerprintOf, loadTrust, saveTrust } from './trust.js'

import { type AdminUser, type OrgMember, type OrgPending, type PermissionSet, type SharePermission, api } from '../../lib/api.js'
import { useEdition } from '../../lib/instance.js'
import { Link, href, navigate } from '../../lib/router.js'
import { refreshScopes } from '../../lib/workspace.js'
import * as session from '../../lib/session.js'
import { IconAlert, IconCheck, IconFolder, IconPlus, IconShield, IconUser, IconX } from '../../ui/icons.js'
import { CopyButton, useToast } from '../../ui/kit.js'
import { Shell } from '../../ui/Shell.js'
import { type CollectionView, type OrgView, type Teams, useTeams } from './model.js'
import { when } from '../../lib/format.js'

const PERMISSION_LABEL: Record<SharePermission, string> = { view: 'Can view', edit: 'Can edit', manage: 'Can manage' }

export function Orgs({ state }: { state: session.Unlocked }) {
  const toast = useToast()
  const teams = useTeams(state.vaultKey)
  const [name, setName] = useState('')
  const [showKey, setShowKey] = useState<{ org: string; key: string; id: string } | null>(null)
  const newcomer = teams.orgs.length === 0 && teams.invitations.length === 0
  // A business Vault has one company (decisions/0032): created once, then never offered again.
  const { edition } = useEdition()
  const business = edition === 'business'
  const hasCompany = teams.orgs.some((o) => o.kind !== 'direct')
  const fingerprint = (
        <section className="settings-card" aria-labelledby="o-fp">
          <div className="settings-card-head"><IconShield size={18} /><h2 id="o-fp">Your fingerprint</h2></div>
          <p className="muted small">When you join an organization, an admin confirms you by checking this matches what they see. Read it to them on a call or in person — not by email or chat.</p>
          <div className="fingerprint">{teams.identity ? <><code>{teams.identity.fingerprint}</code><CopyButton value={teams.identity.fingerprint} label="Fingerprint" /></> : <span className="muted">Loading…</span>}</div>
        </section>
  )
  const invitedOnly = (
        <section className="settings-card" aria-labelledby="o-invited">
          <div className="settings-card-head"><IconUser size={18} /><h2 id="o-invited">Companies on this server</h2></div>
          <p className="muted small">Companies here are invited by the people who run this server: ask them if yours should have one. You can still share an item with one person, from the item&apos;s <strong>Share</strong> button.</p>
        </section>
  )
  const newOrg = (
        <form className="settings-card" aria-labelledby="o-new" onSubmit={async (e) => {
          e.preventDefault()
          try {
            const made = await teams.createOrg(name.trim(), state.email.split('@')[0]!)
            refreshScopes()
            setShowKey({ org: name.trim(), key: made.recoveryKey, id: made.id }); setName(''); toast('Organization created')
          } catch (err) { toast(err instanceof Error ? err.message : 'Could not create it.', 'error') }
        }}>
          <div className="settings-card-head"><IconPlus size={18} /><h2 id="o-new">{business ? 'Create your company' : 'New organization'}</h2></div>
          <div className="field"><label htmlFor="o-name">Name</label><input id="o-name" required maxLength={80} placeholder="e.g. Acme Finance" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <p className="hint">You become its owner and manage it from the <strong>Admin console</strong>. The name is encrypted for members; people you invite see it in their invitation.</p>
          <div className="settings-actions"><button className="btn btn-primary" type="submit" disabled={!name.trim()}>Create</button></div>
        </form>
  )

  return (
    <Shell state={state}>
      <main className="settings">
        <div className="settings-head">
          <ol className="crumbs crumbs-admin" aria-label="Breadcrumb">
            <li><Link to="/app/">Vault</Link></li>
            <li aria-current="page">My organizations</li>
          </ol>
          <h1>My organizations</h1>
          <p className="muted">The teams you belong to and what they share with you. Shared items are used from your vault, under <strong>Shared</strong>; everything is encrypted to your own key.</p>
        </div>

        {teams.error ? <p className="alert alert-error"><IconAlert size={16} />{teams.error}</p> : null}

        {teams.invitations.length ? (
          <section className="settings-card" aria-labelledby="o-inv">
            <div className="settings-card-head"><IconUser size={18} /><h2 id="o-inv">Invitations</h2></div>
            <ul className="device-list">
              {teams.invitations.map((i) => (
                <li key={i.orgId} className="device-row">
                  <div className="device-text"><span className="device-name">{i.hint || 'An organization'}</span><span className="muted small">as {i.role}</span></div>
                  <div className="device-actions">
                    <button className="btn btn-secondary btn-sm" onClick={async () => { await api.orgs.decline(await session.token(), i.orgId); await teams.load() }}>Decline</button>
                    <button className="btn btn-primary btn-sm" onClick={async () => { await api.orgs.accept(await session.token(), i.orgId); toast('Joined. An admin will confirm you.'); await teams.load() }}>Accept</button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {teams.orgs.map((o) => <MemberCard key={o.id} org={o} teams={teams} />)}

        {/* Someone in no organization yet sees how to start one first; someone in
            one needs their fingerprint first, for the admins who confirm them. */}
        {!teams.loaded ? fingerprint
          : business && hasCompany ? fingerprint
          // A hosted server's companies are invited by its operator (decisions/0033).
          : state.canCreateCompany === false ? <>{fingerprint}{invitedOnly}</>
          : newcomer ? <>{newOrg}{fingerprint}</> : <>{fingerprint}{newOrg}</>}
      </main>
      {showKey ? <RecoveryKeyShown org={showKey.org} recoveryKey={showKey.key} onDone={() => { const id = showKey.id; setShowKey(null); navigate(href({ name: 'console', scope: 'org', org: id, section: 'members' })) }} /> : null}
    </Shell>
  )
}

/** One organization, as a member sees it: what it requires, the collections it
 *  shares with you and asking for more. Admins manage it in the console. */
function MemberCard({ org, teams }: { org: OrgView; teams: Teams }) {
  const admin = org.status === 'confirmed' && (org.role === 'owner' || org.role === 'admin') && org.kind !== 'direct'
  const guest = org.role === 'guest'
  const colls = teams.collections.filter((c) => c.orgId === org.id)
  const mine = colls.filter((c) => c.permission)
  const others = colls.filter((c) => !c.permission)
  const { sets } = usePermissionSets(org.status === 'confirmed' ? org.id : undefined)

  // Suspended by the server's operator (hosted, admin console phase 4).
  if (org.suspended) {
    return (
      <section className="settings-card org-card" aria-label={org.name}>
        <div className="settings-card-head"><IconUser size={18} /><h2>{org.name}</h2><span className="pill pill-danger">Suspended</span></div>
        <p className="muted small">This company is suspended by the people who run this server. Your own vault still works; its shared collections come back when it is resumed. Ask them, or your company admin.</p>
      </section>
    )
  }
  // A guest whose time is up (2d).
  if (org.ended) {
    return (
      <section className="settings-card org-card" aria-label={org.name}>
        <div className="settings-card-head"><IconUser size={18} /><h2>{org.name}</h2><span className="pill">Guest · ended</span></div>
        <p className="muted small">Your guest access ended{org.until ? ` on ${when(org.until)}` : ''}. Ask one of its admins if you still need it.</p>
      </section>
    )
  }
  if (org.status !== 'confirmed') {
    return (
      <section className="settings-card org-card" aria-label={org.name}>
        <div className="settings-card-head"><IconUser size={18} /><h2>{org.name}</h2><span className="pill">Waiting</span></div>
        <p className="muted small">You have joined. An admin must confirm you — by checking your fingerprint (below) — before anything is shared with you.</p>
        <OrgRecovery org={org} teams={teams} />
      </section>
    )
  }
  // A direct share (D11) made by this account: confirming the other person
  // happens here, not in the admin console, which is for organizations.
  if (org.kind === 'direct' && (org.role === 'owner' || org.role === 'admin')) return <DirectShare org={org} teams={teams} />
  return (
    <section className="settings-card org-card" aria-label={org.name}>
      <div className="settings-card-head"><IconUser size={18} /><h2>{org.name}</h2>
        {org.kind === 'direct' ? <span className="pill" title="Made by Share with a person: just the two of you">Direct share</span>
          : guest ? <span className="pill pill-accent">Guest{org.until ? ` until ${when(org.until)}` : ''}</span>
          : <span className="pill pill-accent">{org.role}</span>}
      </div>
      {org.policyGap ? <p className="alert alert-warn"><IconAlert size={16} />{org.policyGap} Until then, its collections stay closed to you.</p> : <PolicySummary org={org} />}
      {org.ownerChanged ? <OwnerChanged org={org} teams={teams} /> : null}
      {admin ? (
        <p className="org-manage"><Link className="btn btn-secondary btn-sm" to={href({ name: 'console', scope: 'org', org: org.id, section: 'members' })}>Manage {org.name} in the Admin console</Link></p>
      ) : null}

      <h3 className="small-head">Shared with you</h3>
      {mine.length === 0 ? <p className="muted small">{guest ? 'Nothing yet. An admin gives you the collections you need.' : 'Nothing yet. An admin gives you collections; ask for one below.'}</p> : (
        <ul className="device-list">{mine.map((c) => <CollectionRow key={c.id} c={c} teams={teams} members={[]} groups={[]} manageable={false} sets={sets} />)}</ul>
      )}
      {others.length ? (
        <>
          <h3 className="small-head">Other collections</h3>
          <ul className="device-list">{others.map((c) => <CollectionRow key={c.id} c={c} teams={teams} members={[]} groups={[]} manageable={false} sets={sets} />)}</ul>
        </>
      ) : null}
      {!admin && !guest ? <details className="org-more"><summary className="small">If every owner is locked out</summary><OrgRecovery org={org} teams={teams} /></details> : null}
    </section>
  )
}

function DirectShare({ org, teams }: { org: OrgView; teams: Teams }) {
  const people = useOrgPeople(org, teams)
  return <OrgMembers org={org} teams={teams} selfId={session.get()?.userId ?? ''} people={people} direct />
}

/** What the server knows about an account: last sign-in and two-factor. */
function AccountFacts({ a }: { a: AdminUser }) {
  return (
    <span className="account-facts muted small">
      {a.lastLoginAt ? `Signed in ${when(a.lastLoginAt)}` : 'Never signed in'}
      {' · '}{a.twoFactor ? <span className="fact-ok">two-factor on</span> : <span className="fact-warn">no two-factor</span>}
    </span>
  )
}

function OwnerChanged({ org, teams }: { org: OrgView; teams: Teams }) {
  const toast = useToast()
  return (
    <div className="alert alert-warn" role="alert"><IconAlert size={16} />
      <span><strong>The owner&apos;s key changed.</strong> Keys they share are not trusted until you check: ask the owner to read you their fingerprint (My organizations → Your fingerprint), and compare it with the one in this organization&apos;s member list. <button className="link" onClick={async () => { await resetOwnerPin(org.id, teams); toast('The new owner key is trusted') }}>It matches — trust the new key</button></span>
    </div>
  )
}

/** Members, people invited, and groups, loaded together: every admin section
 *  needs some of them. */
export function useOrgPeople(org: OrgView | undefined, teams: Teams) {
  const [members, setMembers] = useState<OrgMember[]>([])
  const [pending, setPending] = useState<OrgPending[]>([])
  const [groups, setGroups] = useState<GroupView[]>([])
  const reload = async () => {
    if (!org || org.status !== 'confirmed') return
    const t = await session.token()
    const [r, g] = await Promise.all([api.orgs.members(t, org.id), api.orgs.groups(t, org.id)])
    setMembers(r.members); setPending(r.pending)
    setGroups(await Promise.all(g.groups.map(async (x) => ({ id: x.id, members: x.members, name: await teams.groupName(org.id, x.id, x.nameBlob) }))))
  }
  useEffect(() => { void reload() }, [org?.id, org?.status, teams.collections.length])
  return { members, pending, groups, reload }
}
export type OrgPeople = ReturnType<typeof useOrgPeople>

/** The admin's members section: confirming by fingerprint, re-confirming
 *  after a key change, removing, and inviting. */
export function OrgMembers({ org, teams, selfId, people, direct = false }: { org: OrgView; teams: Teams; selfId: string; people: OrgPeople; direct?: boolean }) {
  const toast = useToast()
  const { members, pending, groups } = people
  const [confirming, setConfirming] = useState<{ m: OrgMember; fp: string } | null>(null)
  const [reconfirming, setReconfirming] = useState<{ m: OrgMember; fp: string } | null>(null)
  const [email, setEmail] = useState('')
  const [label, setLabel] = useState('')
  const [inviteGroups, setInviteGroups] = useState<string[]>([])
  // A guest (2d): only the collections given to them, optionally until a date.
  const [inviteRole, setInviteRole] = useState<'member' | 'guest'>('member')
  const [guestUntil, setGuestUntil] = useState('')
  const waiting = members.filter((m) => m.status === 'accepted')
  // People (decisions/0032): with the server's account facts and actions for
  // an admin who also holds those permissions, and in a business Vault, the
  // accounts not yet in the company.
  const { edition } = useEdition()
  const perms = new Set(session.get()?.permissions ?? [])
  const seeAccounts = !direct && perms.has('users.read')
  const manageAccounts = !direct && perms.has('users.write')
  const [accounts, setAccounts] = useState<AdminUser[] | null>(null)
  const loadAccounts = async () => { if (seeAccounts) setAccounts((await api.admin.allUsers(await session.token())).users) }
  useEffect(() => { void loadAccounts().catch(() => setAccounts(null)) }, [seeAccounts, members.length])
  const accountOf = (id: string) => accounts?.find((a) => a.userId === id)
  const outside = edition === 'business' && accounts ? accounts.filter((a) => !members.some((m) => m.userId === a.userId)) : []
  const [signup, setSignup] = useState<{ label: string; code: string; emailed: boolean; expiresAt: string; warning?: string } | null>(null)
  async function accountAction(label: string, run: (t: string) => Promise<unknown>, done: string) {
    try { await run(await session.token()); toast(done); await loadAccounts() }
    catch (err) { toast(err instanceof Error ? err.message : `Could not ${label}.`, 'error') }
  }
  // Waiting for confirmation first, then owners and admins, then by name.
  const rank = (m: OrgMember) => (m.status === 'accepted' ? 0 : m.role === 'owner' ? 1 : m.role === 'admin' ? 2 : 3)
  const sorted = [...members].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label))

  return (
    <section className="settings-card org-card" aria-label={org.name}>
      <div className="settings-card-head"><IconUser size={18} /><h2>{org.name}</h2>{direct
        ? <span className="pill" title="Made by Share with a person: just the two of you">Direct share</span>
        : <span className="muted small">{members.length} member{members.length === 1 ? '' : 's'}{pending.length ? ` · ${pending.length} invited` : ''}</span>}</div>
      {waiting.length ? <p className="alert alert-info"><IconAlert size={16} /><span>{waiting.length === 1 ? `${waiting[0]!.label} is` : `${waiting.length} people are`} waiting for you to confirm them. Ask them to read you their fingerprint first.</span></p> : null}
      {org.ownerChanged ? <OwnerChanged org={org} teams={teams} /> : null}

      <ul className="device-list">
        {sorted.map((m) => (
          <li key={m.userId} className="device-row">
            <div className="device-text">
              <span className="device-name">{m.label}{m.userId === selfId ? <span className="pill">You</span> : null}{accountOf(m.userId)?.disabled ? <span className="pill pill-danger">Disabled</span> : null}</span>
              <span className="muted small">{m.role === 'guest' ? `guest${m.until ? (m.ended ? ` · ended ${when(m.until)}` : ` · until ${when(m.until)}`) : ''}` : m.role} · {m.status === 'confirmed' ? 'confirmed' : 'waiting for confirmation'}</span>
              {accountOf(m.userId) ? <AccountFacts a={accountOf(m.userId)!} /> : null}
            </div>
            <div className="device-actions">
              {manageAccounts && accountOf(m.userId) && m.userId !== selfId && m.role !== 'owner' ? (
                <details className="account-menu">
                  <summary className="btn btn-ghost btn-sm" aria-label={`Account actions for ${m.label}`}>Account</summary>
                  <div className="account-menu-pop">
                    <button className="btn btn-ghost btn-sm" onClick={() => void accountAction('change it', (t) => api.admin.setDisabled(t, m.userId, !accountOf(m.userId)!.disabled), accountOf(m.userId)!.disabled ? `${m.label} can sign in again` : `${m.label} is disabled`)}>{accountOf(m.userId)!.disabled ? 'Enable sign-in' : 'Disable sign-in'}</button>
                    {accountOf(m.userId)!.twoFactor ? <button className="btn btn-ghost btn-sm" onClick={() => { if (window.confirm(`Turn off two-factor sign-in for ${m.label}? Do this only after confirming who is asking.`)) void accountAction('reset it', (t) => api.admin.resetTwoFactor(t, m.userId), 'Two-factor sign-in turned off') }}>Reset two-factor</button> : null}
                    <button className="btn btn-ghost btn-sm" onClick={() => { if (window.confirm(`Offboard ${m.label}? Their sign-in is disabled and every device signed out.`)) void accountAction('offboard', (t) => api.admin.offboard(t, m.userId), `${m.label} offboarded`) }}>Offboard…</button>
                  </div>
                </details>
              ) : null}
              {m.status === 'accepted' ? (
                <button className="btn btn-primary btn-sm" onClick={async () => setConfirming({ m, fp: await fingerprintOf(m.publicKey, m.currentSigningKey ?? null) })}>Confirm…</button>
              ) : null}
              {m.status === 'confirmed' && m.currentSigningKey && m.currentSigningKey !== m.signingPublicKey && m.userId !== selfId ? (
                <button className="btn btn-secondary btn-sm" title="Their fingerprint changed: a signing key was added" onClick={async () => setReconfirming({ m, fp: await fingerprintOf(m.publicKey, m.currentSigningKey ?? null) })}>Re-confirm…</button>
              ) : null}
              {m.role !== 'owner' && m.userId !== selfId ? (
                <button className="icon-btn icon-danger" aria-label={`Remove ${m.label}`} title="Remove" onClick={async () => {
                  if (!window.confirm(`Remove ${m.label}? They lose access at once.`)) return
                  const r = await api.orgs.removeMember(await session.token(), org.id, m.userId)
                  await people.reload(); await teams.load()
                  // Re-key what they could open, where this admin can.
                  let rotated = 0
                  for (const cid of r.rotationNeeded) {
                    if (teams.collections.find((c) => c.id === cid)?.permission !== 'manage') continue
                    try { await teams.rotate(cid); rotated++ } catch { /* left marked; the Rotate button retries */ }
                  }
                  const keys = r.rotationNeeded.length ? ` ${rotated} of ${r.rotationNeeded.length} collection key(s) rotated.` : ''
                  const pw = r.passwordsToChange ? ` ${r.passwordsToChange} password${r.passwordsToChange === 1 ? '' : 's'} they could see ${r.passwordsToChange === 1 ? 'is' : 'are'} listed in Password health to change.` : ''
                  toast(`Removed.${keys}${pw}`)
                }}><IconX size={15} /></button>
              ) : null}
            </div>
          </li>
        ))}
        {pending.map((p) => (
          <li key={p.id} className="device-row">
            <div className="device-text"><span className="device-name">{p.label}</span><span className="muted small">invited · has not joined yet{p.groups?.length ? ` · will join ${p.groups.map((g) => groups.find((x) => x.id === g)?.name ?? 'a group').join(', ')}` : ''}</span></div>
            <button className="btn btn-secondary btn-sm" onClick={async () => { await api.orgs.withdraw(await session.token(), org.id, p.id); await people.reload() }}>Withdraw</button>
          </li>
        ))}
      </ul>

      {outside.length ? (
        <>
          <h3 className="small-head">On this server, not in {org.name}</h3>
          <ul className="device-list">
            {outside.map((a) => (
              <li key={a.userId} className="device-row outside-row">
                <div className="device-text">
                  <span className="device-name">{a.label || <span className="muted">Unlabelled account</span>}{a.disabled ? <span className="pill pill-danger">Disabled</span> : null}</span>
                  <AccountFacts a={a} />
                </div>
                {pending.some((p) => p.label === a.label) ? <span className="muted small">Invited</span> : (
                  <button className="btn btn-secondary btn-sm" disabled={a.disabled} onClick={async () => {
                    try { await api.orgs.inviteAccount(await session.token(), org.id, a.userId); toast(`${a.label || 'They'} will see the invitation when they sign in`); await people.reload() }
                    catch (err) { toast(err instanceof Error ? err.message : 'Could not invite.', 'error') }
                  }}>Add to {edition === 'business' ? 'company' : org.name}</button>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {reconfirming ? (
        <div className="confirm" role="dialog" aria-label="Re-confirm member">
          <p><strong>{reconfirming.m.label}&apos;s fingerprint changed</strong> because their app added a signing key, which lets it check who shared a key with it. Re-confirm only if they read you exactly this:</p>
          <p className="fingerprint"><code>{reconfirming.fp}</code></p>
          <div className="confirm-actions">
            <button className="btn btn-secondary btn-sm" onClick={() => setReconfirming(null)}>Cancel</button>
            <button className="btn btn-primary btn-sm" onClick={async () => {
              try { await api.orgs.reconfirm(await session.token(), org.id, reconfirming.m.userId); toast(`${reconfirming.m.label} re-confirmed`); setReconfirming(null); await people.reload(); await teams.load() }
              catch (err) { toast(err instanceof Error ? err.message : 'Could not re-confirm.', 'error') }
            }}><IconCheck size={15} />It matches — re-confirm</button>
          </div>
        </div>
      ) : null}

      {confirming ? (
        <div className="confirm" role="dialog" aria-label="Confirm member">
          <p><strong>Confirm {confirming.m.label}</strong> only if they read you exactly this fingerprint — on a call or in person:</p>
          <p className="fingerprint"><code>{confirming.fp}</code></p>
          <p className="muted small">If it differs, someone may be impersonating them. Do not confirm; remove them instead.</p>
          <div className="confirm-actions">
            <button className="btn btn-secondary btn-sm" onClick={() => setConfirming(null)}>Cancel</button>
            <button className="btn btn-primary btn-sm" onClick={async () => {
              try {
                await teams.confirm(org.id, confirming.m.userId, confirming.m.publicKey)
                // A direct share (D11) exists to give them its items: do it now.
                await teams.grantDirect(org.id, confirming.m.userId, confirming.m.publicKey)
                // Groups chosen when they were invited (B2): joined now, with keys sealed here.
                let joined = 0
                for (const g of confirming.m.pendingGroups ?? []) {
                  try { await teams.addToGroup(org.id, g, confirming.m.userId, confirming.m.publicKey); joined++ } catch { /* stays pending; add by hand */ }
                }
                toast(joined ? `${confirming.m.label} confirmed and added to ${joined} group${joined === 1 ? '' : 's'}` : `${confirming.m.label} confirmed`)
                setConfirming(null); await people.reload(); await teams.load()
              }
              catch (err) { toast(err instanceof Error ? err.message : 'Could not confirm.', 'error') }
            }}><IconCheck size={15} />It matches — confirm</button>
          </div>
        </div>
      ) : null}

      {direct ? null : <form className="org-invite" onSubmit={async (e) => {
        e.preventDefault()
        try {
          // A business Vault sends someone without an account a sign-up code too (0032).
          const until = inviteRole === 'guest' && guestUntil ? new Date(`${guestUntil}T23:59:59`).toISOString() : undefined
          const res = await api.orgs.invite(await session.token(), org.id, email.trim(), label.trim(), inviteRole, inviteGroups, edition === 'business', until)
          const who = label.trim() || email.trim().split('@')[0]!
          if (res.signup) setSignup({ label: who, ...res.signup, ...(res.warning ? { warning: res.warning } : {}) })
          else toast('Invited. They will see it when they sign in.')
          setEmail(''); setLabel(''); setInviteGroups([]); setInviteRole('member'); setGuestUntil(''); await people.reload()
        } catch (err) { toast(err instanceof Error ? err.message : 'Could not invite.', 'error') }
      }}>
        <h3 className="small-head">Invite someone</h3>
        <div className="inline-form">
          <input type="email" required placeholder="Email to invite" aria-label="Email to invite" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input placeholder="Name (for you)" aria-label="Name for this member" maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} />
          <select aria-label="Invite as" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as 'member' | 'guest')}>
            <option value="member">Member</option>
            <option value="guest">Guest</option>
          </select>
          <button className="btn btn-secondary btn-sm" type="submit">Invite</button>
        </div>
        {inviteRole === 'guest' ? (
          <div className="guest-until">
            <label htmlFor="guest-until" className="small">Guest until <span className="muted">(optional)</span></label>
            <input id="guest-until" type="date" value={guestUntil} min={new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)} max={new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10)} onChange={(e) => setGuestUntil(e.target.value)} />
            <p className="hint">A guest sees only the collections you give them, not the other members or groups, and cannot ask for more. Their access ends on this date.</p>
          </div>
        ) : null}
        {groups.length ? (
          <div className="invite-groups" role="group" aria-label="Add to groups once confirmed">
            <span className="small muted">Add to groups once confirmed:</span>
            {groups.map((g) => (
              <label key={g.id} className="check"><input type="checkbox" checked={inviteGroups.includes(g.id)}
                onChange={(e) => setInviteGroups(e.target.checked ? [...inviteGroups, g.id] : inviteGroups.filter((x) => x !== g.id))} /><span>{g.name}</span></label>
            ))}
          </div>
        ) : null}
        <p className="hint">{edition === 'business'
          ? 'Someone without an account gets a sign-up code. They accept under My organizations, then you confirm them here by fingerprint.'
          : 'They need an account on this server. They accept under My organizations, then you confirm them here by fingerprint.'}</p>
        {signup ? (
          <div className="confirm signup-code" role="status">
            <p><strong>{signup.label} has no account yet.</strong> {signup.emailed ? 'They were emailed a sign-up link.' : 'Send them this sign-up code, by a channel you trust:'} It works once, until {when(signup.expiresAt)}; then they accept the invitation and you confirm them here.</p>
            {signup.emailed ? null : <div className="recovery-key"><code>{signup.code}</code><CopyButton value={signup.code} label="Sign-up code" /></div>}
            {signup.warning ? <p className="alert alert-warn"><IconAlert size={16} />{signup.warning}</p> : null}
            <div className="confirm-actions"><button type="button" className="btn btn-secondary btn-sm" onClick={() => setSignup(null)}>Done</button></div>
          </div>
        ) : null}
      </form>}
    </section>
  )
}

/** The admin's collections section: access requests first, then every
 *  collection with who can open it, then a new one. */
export function OrgCollections({ org, teams, people }: { org: OrgView; teams: Teams; people: OrgPeople }) {
  const toast = useToast()
  const { sets } = usePermissionSets(org.id)
  const [collName, setCollName] = useState('')
  const colls = teams.collections.filter((c) => c.orgId === org.id)
  return (
    <section className="settings-card org-card" aria-label={org.name}>
      <div className="settings-card-head"><IconFolder size={18} /><h2>{org.name}</h2><span className="muted small">{colls.length} collection{colls.length === 1 ? '' : 's'}</span></div>
      <Requests org={org} teams={teams} members={people.members} />
      {colls.length === 0 ? <p className="muted small">No collections yet. A collection is a shared folder: items moved into it are encrypted to everyone you give it to.</p> : (
        <ul className="device-list">
          {colls.map((c) => <CollectionRow key={c.id} c={c} teams={teams} members={people.members} groups={people.groups} sets={sets} />)}
        </ul>
      )}
      <form className="inline-form" onSubmit={async (e) => {
        e.preventDefault()
        try { await teams.createCollection(org.id, collName.trim()); setCollName(''); toast('Collection created') }
        catch (err) { toast(err instanceof Error ? err.message : 'Could not create it.', 'error') }
      }}>
        <input required placeholder="New collection, e.g. Finance" aria-label="New collection name" maxLength={80} value={collName} onChange={(e) => setCollName(e.target.value)} />
        <button className="btn btn-secondary btn-sm" type="submit"><IconPlus size={14} />Add collection</button>
      </form>
    </section>
  )
}

/** The console's Permission sets section (decisions/0032, 2b): the built-in
 *  sets, and custom ones an admin makes from the same rights. */
export function PermissionSets({ org }: { org: OrgView }) {
  const toast = useToast()
  const { sets, reload } = usePermissionSets(org.id)
  const blank = { id: '', name: '', level: 'view' as SharePermission, reveal: true, fill: true, export: false }
  const [draft, setDraft] = useState<typeof blank | null>(null)
  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!draft) return
    try { await api.orgs.putPermissionSet(await session.token(), org.id, { ...draft, id: draft.id || crypto.randomUUID(), name: draft.name.trim() }); toast(`Saved ${draft.name.trim()}`); setDraft(null); await reload() }
    catch (err) { toast(err instanceof Error ? err.message : 'Could not save it.', 'error') }
  }
  return (
    <section className="settings-card org-card" aria-label={org.name}>
      <div className="settings-card-head"><IconShield size={18} /><h2>{org.name}</h2><span className="muted small">{sets.length} set{sets.length === 1 ? '' : 's'}</span></div>
      <ul className="device-list set-list">
        {sets.map((x) => (
          <li key={x.id} className="device-row set-row">
            <div className="device-text">
              <span className="device-name">{x.name}{x.builtin ? <span className="pill">Built in</span> : null}</span>
              <span className="muted small">{describeSet(x)}</span>
            </div>
            {x.builtin ? null : (
              <div className="device-actions">
                <button className="btn btn-secondary btn-sm" onClick={() => setDraft({ id: x.id, name: x.name, level: x.level, reveal: x.reveal, fill: x.fill, export: x.export })}>Edit</button>
                <button className="icon-btn icon-danger" aria-label={`Remove ${x.name}`} onClick={async () => {
                  if (!window.confirm(`Remove the permission set ${x.name}?`)) return
                  try { await api.orgs.deletePermissionSet(await session.token(), org.id, x.id); toast(`${x.name} removed`); await reload() }
                  catch (err) { toast(err instanceof Error ? err.message : 'Could not remove it.', 'error') }
                }}><IconX size={15} /></button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {draft ? (
        <form className="set-form" onSubmit={save} aria-label={draft.id ? `Edit ${draft.name}` : 'New permission set'}>
          <div className="field"><label htmlFor="set-name">Name</label><input id="set-name" required maxLength={80} placeholder="e.g. Auditor" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
          <fieldset className="field set-level"><legend>Items</legend>
            {(['view', 'edit', 'manage'] as SharePermission[]).map((l) => (
              <label key={l} className="check"><input type="radio" name="set-level" checked={draft.level === l} onChange={() => setDraft({ ...draft, level: l })} />
                <span>{l === 'view' ? 'Open and use them' : l === 'edit' ? 'Add and change them' : 'Add and change them, and give access'}</span></label>
            ))}
          </fieldset>
          <label className="check"><input type="checkbox" checked={draft.reveal} onChange={(e) => setDraft({ ...draft, reveal: e.target.checked })} /><span>See and copy passwords (off: fill only)</span></label>
          <label className="check"><input type="checkbox" checked={draft.fill} onChange={(e) => setDraft({ ...draft, fill: e.target.checked })} /><span>Fill pages with the browser extension</span></label>
          <label className="check"><input type="checkbox" checked={draft.export} onChange={(e) => setDraft({ ...draft, export: e.target.checked })} /><span>Include items in organization backups</span></label>
          <p className="hint">Changing a set changes it for everyone it was given to.</p>
          <div className="settings-actions"><button type="button" className="btn btn-secondary btn-sm" onClick={() => setDraft(null)}>Cancel</button><button type="submit" className="btn btn-primary btn-sm" disabled={!draft.name.trim()}>Save set</button></div>
        </form>
      ) : <button className="btn btn-secondary btn-sm" onClick={() => setDraft(blank)}><IconPlus size={14} />New permission set</button>}
    </section>
  )
}

/** What a permission set lets someone do, in words. */
export function describeSet(s: PermissionSet): string {
  const level = s.level === 'view' ? 'open and use items' : s.level === 'edit' ? 'add and change items' : 'add and change items, and give access'
  const parts = [level, s.reveal ? 'see and copy passwords' : 'fill passwords without seeing them']
  if (!s.fill) parts.push('no filling in the browser extension')
  if (s.export) parts.push('include items in backups')
  return parts.join(' · ')
}

/** The organization's permission sets, built-in and custom (2b). */
export function usePermissionSets(orgId: string | undefined) {
  const [sets, setSets] = useState<PermissionSet[]>([])
  const reload = async () => { if (orgId) setSets((await api.orgs.permissionSets(await session.token(), orgId)).sets) }
  useEffect(() => { void reload().catch(() => setSets([])) }, [orgId])
  return { sets, reload }
}

export function CollectionRow({ c, teams, members, groups, manageable = true, sets = [] }: { c: CollectionView; teams: Teams; members: OrgMember[]; groups: { id: string; name: string }[]; manageable?: boolean; sets?: PermissionSet[] }) {
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [grants, setGrants] = useState<{ userId: string; permission: SharePermission; hidePasswords: boolean; set: string }[]>([])
  const [who, setWho] = useState('')
  const [setId, setSetId] = useState('viewer')
  const [group, setGroup] = useState('')
  const manage = manageable && c.permission === 'manage'
  const load = async () => setGrants((await api.orgs.access(await session.token(), c.orgId, c.id)).access)
  const chosen = sets.find((x) => x.id === setId)
  const setName = (id: string) => sets.find((x) => x.id === id)?.name ?? id
  const mine = c.rights ? setName(c.rights.set) : c.permission ? PERMISSION_LABEL[c.permission] : null

  return (
    <li className="device-row collection-row">
      <div className="device-text">
        <span className="device-name"><IconFolder size={15} /> {c.name}
          {c.rotationNeeded ? <span className="pill pill-danger" title="Someone lost access; their copy of the key should be retired">Key rotation due</span> : null}
        </span>
        {c.untrusted ? <span className="pill pill-danger" title="Its signature did not check out against an admin you trust">Key not trusted</span> : null}
        <span className="muted small">{mine ?? 'You have no access'}{c.hidePasswords ? ' · passwords hidden' : ''}{c.until ? ` · until ${when(c.until)}` : ''}</span>
        {!c.permission ? (
          c.requested ? <span className="pill">Access requested</span> : (
            <button className="btn btn-secondary btn-sm" onClick={async () => {
              const reason = window.prompt(`Why do you need ${c.name}? (optional, the admins see this)`) ?? null
              if (reason === null) return
              try { await api.orgs.requestAccess(await session.token(), c.orgId, c.id, reason); toast('Asked. The admins have been told.'); await teams.load() }
              catch (err) { toast(err instanceof Error ? err.message : 'Could not ask.', 'error') }
            }}>Request access</button>
          )
        ) : null}
        {open ? (
          <div className="access-panel">
            <ul className="access-list">
              {grants.map((g) => {
                const m = members.find((x) => x.userId === g.userId)
                return <li key={g.userId}><span>{m?.label ?? 'Member'}</span><span className="muted small">{setName(g.set)}</span>
                  {m && m.role !== 'owner' ? <button className="icon-btn icon-sm icon-danger" aria-label={`Remove ${m.label}'s access`} onClick={async () => { await api.orgs.revoke(await session.token(), c.orgId, c.id, g.userId); await load(); await teams.load() }}><IconX size={13} /></button> : null}
                </li>
              })}
            </ul>
            <form className="inline-form" onSubmit={async (e) => {
              e.preventDefault()
              const m = members.find((x) => x.userId === who)!
              try { await teams.grant(c.id, m.userId, m.publicKey, setId); toast(`${m.label}: ${chosen?.name ?? setId} in ${c.name}`); setWho(''); await load() }
              catch (err) { toast(err instanceof Error ? err.message : 'Could not share.', 'error') }
            }}>
              <select aria-label="Member" required value={who} onChange={(e) => setWho(e.target.value)}>
                <option value="">Give access to…</option>
                {members.filter((m) => m.status === 'confirmed' && !grants.some((g) => g.userId === m.userId)).map((m) => <option key={m.userId} value={m.userId}>{m.label}</option>)}
              </select>
              <select aria-label="Permission set" value={setId} onChange={(e) => setSetId(e.target.value)}>
                {sets.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
              <button className="btn btn-secondary btn-sm" type="submit" disabled={!who}>Share</button>
            </form>
            {groups.length ? (
              <form className="inline-form" onSubmit={async (e) => {
                e.preventDefault()
                try { await teams.grantGroup(c.id, group, setId); toast('Group given access'); setGroup(''); await load() }
                catch (err) { toast(err instanceof Error ? err.message : 'Could not share.', 'error') }
              }}>
                <select aria-label="Group" required value={group} onChange={(e) => setGroup(e.target.value)}>
                  <option value="">Give access to a group…</option>
                  {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
                <button className="btn btn-secondary btn-sm" type="submit" disabled={!group}>Share with group</button>
              </form>
            ) : null}
            {chosen ? <p className="hint set-hint"><strong>{chosen.name}:</strong> {describeSet(chosen)}.</p> : null}
            <p className="hint">Seeing passwords, filling and backups are kept by the apps, not by encryption: anyone who can open a collection holds its key.</p>
          </div>
        ) : null}
      </div>
      {manage ? <div className="device-actions">
        {c.rotationNeeded ? <button className="btn btn-primary btn-sm" onClick={async () => {
          try { await teams.rotate(c.id); toast(`${c.name}: key rotated`) } catch (err) { toast(err instanceof Error ? err.message : 'Could not rotate.', 'error') }
        }}>Rotate key</button> : null}
        <button className="btn btn-secondary btn-sm" onClick={async () => { if (!open) await load(); setOpen(!open) }}>{open ? 'Done' : 'Access'}</button>
      </div> : null}
    </li>
  )
}

interface GroupView { id: string; name: string; members: string[] }

export function Groups({ org, teams, people, admin = true }: { org: OrgView; teams: Teams; people: OrgPeople; admin?: boolean }) {
  const toast = useToast()
  const [name, setName] = useState('')
  const [adding, setAdding] = useState<Record<string, string>>({})
  const { members, groups: list } = people
  const load = people.reload
  const label = (u: string) => members.find((m) => m.userId === u)?.label ?? 'Member'

  if (!admin && list.length === 0) return null
  return (
    <section className="settings-card org-card" aria-label={org.name}>
      <div className="settings-card-head"><IconUser size={18} /><h2>{org.name}</h2><span className="muted small">{list.length} group{list.length === 1 ? '' : 's'}</span></div>
      <p className="muted small">A group gives a whole team access to collections at once. People added to a group get its collections; removing them retires their copies of the keys.</p>
      {list.length === 0 ? <p className="muted small">No groups yet. A group lets you give a whole team access to a collection at once.</p> : (
        <ul className="device-list">
          {list.map((g) => (
            <li key={g.id} className="device-row group-row">
              <div className="device-text">
                <span className="device-name"><IconUser size={15} /> {g.name}</span>
                <span className="group-members">
                  {g.members.length === 0 ? <span className="muted small">No members</span> : g.members.map((u) => (
                    <span key={u} className="pill">{label(u)}
                      {admin ? <button className="pill-x" aria-label={`Remove ${label(u)} from ${g.name}`} onClick={async () => {
                        const r = await api.orgs.removeFromGroup(await session.token(), org.id, g.id, u)
                        await teams.load()
                        for (const cid of r.rotationNeeded) { try { await teams.rotate(cid) } catch { /* stays marked */ } }
                        toast(`${label(u)} removed from ${g.name}`); await load()
                      }}>×</button> : null}
                    </span>
                  ))}
                </span>
              </div>
              {admin ? (
                <form className="inline-form" onSubmit={async (e) => {
                  e.preventDefault()
                  const u = adding[g.id]; const m = members.find((x) => x.userId === u)
                  if (!m) return
                  try {
                    const r = await teams.addToGroup(org.id, g.id, m.userId, m.publicKey)
                    toast(r.skipped ? `${m.label} added; ${r.skipped} collection(s) need someone who can manage them to share` : `${m.label} added to ${g.name}`)
                    setAdding({ ...adding, [g.id]: '' }); await load(); await teams.load()
                  } catch (err) { toast(err instanceof Error ? err.message : 'Could not add.', 'error') }
                }}>
                  <select aria-label={`Add to ${g.name}`} value={adding[g.id] ?? ''} onChange={(e) => setAdding({ ...adding, [g.id]: e.target.value })}>
                    <option value="">Add member…</option>
                    {members.filter((m) => m.status === 'confirmed' && !g.members.includes(m.userId)).map((m) => <option key={m.userId} value={m.userId}>{m.label}</option>)}
                  </select>
                  <button className="btn btn-secondary btn-sm" type="submit" disabled={!adding[g.id]}>Add</button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {admin ? (
        <form className="inline-form" onSubmit={async (e) => {
          e.preventDefault()
          try { await teams.createGroup(org.id, name.trim()); setName(''); await load(); toast('Group created') }
          catch (err) { toast(err instanceof Error ? err.message : 'Could not create it.', 'error') }
        }}>
          <input required placeholder="New group, e.g. Engineering" aria-label="New group name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn btn-secondary btn-sm" type="submit"><IconPlus size={14} />Add group</button>
        </form>
      ) : null}
    </section>
  )
}

export function PolicySummary({ org }: { org: OrgView }) {
  const p = org.policies
  const rules = [p.requireTwoFactor && 'two-factor sign-in', p.minPasswordScore > 0 && `a master password rated at least ${STRENGTH[p.minPasswordScore]}`, p.maxIdleMinutes && `locking after ${p.maxIdleMinutes} minutes idle`].filter(Boolean)
  return rules.length ? <p className="muted small">This organization requires {rules.join(', ')}.</p> : null
}

const STRENGTH = ['', 'Weak', 'Fair', 'Strong', 'Excellent']

export function PoliciesForm({ org, teams, always = false }: { org: OrgView; teams: Teams; always?: boolean }) {
  const toast = useToast()
  const [p, setP] = useState(org.policies)
  const [open, setOpen] = useState(always)
  if (!open) return <div className="policy-line"><PolicySummary org={org} /><button className="link small" onClick={() => setOpen(true)}>Policies…</button></div>
  return (
    <form className="policies" onSubmit={async (e) => {
      e.preventDefault()
      try { await api.orgs.setPolicies(await session.token(), org.id, p); toast('Policies saved'); if (!always) setOpen(false); await teams.load() }
      catch (err) { toast(err instanceof Error ? err.message : 'Could not save.', 'error') }
    }}>
      <h3 className="small-head">Policies</h3>
      <label className="check"><input type="checkbox" checked={p.requireTwoFactor} onChange={(e) => setP({ ...p, requireTwoFactor: e.target.checked })} /><span>Require two-factor sign-in (checked by the server)</span></label>
      <div className="field"><label htmlFor={`pol-pw-${org.id}`}>Minimum master password strength</label>
        <select id={`pol-pw-${org.id}`} value={p.minPasswordScore} onChange={(e) => setP({ ...p, minPasswordScore: Number(e.target.value) })}>
          <option value={0}>No minimum</option>{[2, 3, 4].map((n) => <option key={n} value={n}>{STRENGTH[n]}</option>)}
        </select>
        <p className="hint">Rated by each member's app when they unlock — the server never sees a master password, so this is self-reported.</p>
      </div>
      <div className="field"><label htmlFor={`pol-idle-${org.id}`}>Lock after idle</label>
        <select id={`pol-idle-${org.id}`} value={p.maxIdleMinutes ?? ''} onChange={(e) => setP({ ...p, maxIdleMinutes: e.target.value ? Number(e.target.value) : null })}>
          <option value="">15 minutes (default)</option>{[1, 5, 10].map((n) => <option key={n} value={n}>{n} minutes</option>)}
        </select>
      </div>
      <p className="alert alert-warn"><IconAlert size={16} />Policies apply to everyone here, you included. Members who do not meet them cannot open the organization's collections until they do.</p>
      <div className="settings-actions">{always ? null : <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(false)}>Cancel</button>}<button type="submit" className="btn btn-primary btn-sm">Save policies</button></div>
    </form>
  )
}

const ACTION_LABEL: Record<string, string> = {
  'item.view': 'opened', 'item.reveal': 'revealed a secret in', 'item.copy': 'copied from', 'item.fill': 'filled a page from', 'item.create': 'added', 'item.edit': 'edited', 'item.delete': 'deleted',
  'access.grant': 'gave access to', 'access.change': 'changed access to', 'access.revoke': 'removed access to', 'access.grant-group': 'gave a group access to',
  'collection.create': 'created', 'collection.delete': 'deleted', 'collection.rotate': 'rotated the key of',
  'member.invite': 'invited', 'member.confirm': 'confirmed', 'member.remove': 'removed', 'member.leave': 'left', 'policies.change': 'changed the policies',
}

export function Activity({ org, teams, members, always = false }: { org: OrgView; teams: Teams; members: OrgMember[]; always?: boolean }) {
  const [open, setOpen] = useState(always)
  const [events, setEvents] = useState<Awaited<ReturnType<typeof api.orgs.events>>['events']>([])
  useEffect(() => { if (always) void session.token().then((t) => api.orgs.events(t, org.id)).then((r) => setEvents(r.events)).catch(() => {}) }, [org.id, always])
  const who = (u: string | null) => members.find((m) => m.userId === u)?.label ?? (u ? 'A former member' : '—')
  const item = (id: string | null) => teams.shared.find((e) => e.id === id)?.name ?? (id ? 'an item' : '')
  const coll = (id: string | null) => teams.collections.find((c) => c.id === id)?.name ?? ''
  return (
    <div className="policy-line">
      {always ? null : <button className="link small" onClick={async () => { if (!open) setEvents((await api.orgs.events(await session.token(), org.id)).events); setOpen(!open) }}>{open ? 'Hide activity' : 'Activity…'}</button>}
      {open ? (
        <div className="audit">
          <p className="muted small">Who did what, for a year. Opening, revealing, copying and filling are reported by each member's app.</p>
          <ul className="activity-list">
            {events.length === 0 ? <li className="muted small">Nothing yet.</li> : events.map((e, i) => {
              const target = e.action.startsWith('item.') ? `${item(e.itemId)} in ${coll(e.collectionId)}`
                : e.action.startsWith('access.') || e.action.startsWith('collection.') ? coll(e.collectionId) + (e.target && e.action !== 'access.grant-group' ? ` (${who(e.target)})` : '')
                : e.action.startsWith('member.') ? (members.find((m) => m.userId === e.target)?.label ?? e.target ?? '') : ''
              return <li key={i}><span><strong>{who(e.actor)}</strong> {ACTION_LABEL[e.action] ?? e.action} {target}</span>
                <span className="muted small">{when(e.at)}{e.reported ? ' · reported by app' : ''}</span></li>
            })}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

const DURATIONS: [number | 0, string][] = [[0, 'For good'], [1, 'For 1 hour'], [8, 'For 8 hours'], [24, 'For 1 day'], [72, 'For 3 days'], [168, 'For 1 week']]

/** Access requests waiting on this organization's admins (D7). Approving
 *  seals the collection key to them here, for good or as a check-out. */
export function Requests({ org, teams, members }: { org: OrgView; teams: Teams; members: OrgMember[] }) {
  const toast = useToast()
  const [list, setList] = useState<{ collectionId: string; userId: string; label: string; reason: string; at: string }[]>([])
  const [choice, setChoice] = useState<Record<string, { perm: SharePermission; hours: number }>>({})
  const load = async () => { try { setList((await api.orgs.requests(await session.token(), org.id)).requests) } catch { setList([]) } }
  useEffect(() => { void load() }, [org.id, teams.collections.length])
  if (!list.length) return null
  return (
    <>
      <h3 className="small-head">Access requests</h3>
      <ul className="device-list requests">
        {list.map((r) => {
          const key = `${r.collectionId}/${r.userId}`
          const c = teams.collections.find((x) => x.id === r.collectionId)
          const m = members.find((x) => x.userId === r.userId)
          const pick = choice[key] ?? { perm: 'view' as SharePermission, hours: 8 }
          const canGrant = c?.permission === 'manage' && m
          return (
            <li key={key} className="device-row">
              <div className="device-text">
                <span className="device-name">{r.label} → {c?.name ?? 'a collection'}</span>
                <span className="muted small">{r.reason ? `“${r.reason}” · ` : ''}asked {when(r.at)}</span>
              </div>
              <div className="device-actions">
                {canGrant ? (
                  <>
                    <select aria-label={`Permission for ${r.label}`} className="select-sm" value={pick.perm} onChange={(e) => setChoice({ ...choice, [key]: { ...pick, perm: e.target.value as SharePermission } })}>
                      <option value="view">Can view</option><option value="edit">Can edit</option>
                    </select>
                    <select aria-label={`How long for ${r.label}`} className="select-sm" value={pick.hours} onChange={(e) => setChoice({ ...choice, [key]: { ...pick, hours: Number(e.target.value) } })}>
                      {DURATIONS.map(([h, l]) => <option key={h} value={h}>{l}</option>)}
                    </select>
                    <button className="btn btn-primary btn-sm" onClick={async () => {
                      try { await teams.grant(r.collectionId, m!.userId, m!.publicKey, pick.perm === 'edit' ? 'editor' : 'viewer', undefined, pick.hours || undefined); toast(`${r.label} can open ${c!.name}${pick.hours ? ` for ${DURATIONS.find(([h]) => h === pick.hours)![1].replace('For ', '')}` : ''}`); await load(); await teams.load() }
                      catch (err) { toast(err instanceof Error ? err.message : 'Could not approve.', 'error') }
                    }}>Approve</button>
                  </>
                ) : <span className="muted small">Needs someone who manages it</span>}
                <button className="btn btn-ghost btn-sm" onClick={async () => {
                  try { await api.orgs.denyRequest(await session.token(), org.id, r.collectionId, r.userId); toast('Turned down'); await load() }
                  catch (err) { toast(err instanceof Error ? err.message : 'Could not decline.', 'error') }
                }}>Decline</button>
              </div>
            </li>
          )
        })}
      </ul>
    </>
  )
}

/** An encrypted copy of the organization's items (C6), made in this browser
 *  from the collections this admin can open. The file is a Vault encrypted
 *  export: each collection a folder under the organization's name, so it
 *  opens in Import & export with its password — on this server or another. */
export function OrgBackup({ org, teams }: { org: OrgView; teams: Teams }) {
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const colls = teams.collections.filter((c) => c.orgId === org.id)
  // Only collections whose permission set allows backups (decisions/0032, 2b).
  const readable = colls.filter((c) => c.key && (c.rights ? c.rights.export : c.permission !== 'view'))
  const items = teams.shared.filter((e) => e.orgId === org.id)
  if (!open) return <button className="link small org-backup-link" onClick={() => setOpen(true)}>Back up this organization…</button>
  return (
    <form className="confirm org-backup" onSubmit={async (e) => {
      e.preventDefault()
      if (pw.length < 12) { toast('Use a password of at least 12 characters.', 'error'); return }
      if (pw !== pw2) { toast('The two passwords do not match.', 'error'); return }
      setBusy(true)
      try {
        const { encryptedExport, today } = await import('../transfer/transfer.js')
        const rootId = crypto.randomUUID()
        const folderOf = new Map(readable.map((c) => [c.id, crypto.randomUUID()]))
        const folders = [{ id: rootId, name: org.name }, ...readable.map((c) => ({ id: folderOf.get(c.id)!, name: c.name, parentId: rootId }))]
        const entries = items.map((it) => {
          const { orgId: _o, collectionId, permission: _p, hidePasswords: _h, exposed: _x, sensitive: _s, ...rest } = it
          return { ...rest, folderId: folderOf.get(collectionId)! }
        })
        const slug = org.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'organization'
        const { download } = await import('../../lib/download.js')
        download(`vault-org-${slug}-${today()}.json`, await encryptedExport(entries, folders, pw), 'application/json')
        toast(`Backed up ${items.length} item${items.length === 1 ? '' : 's'} from ${readable.length} collection${readable.length === 1 ? '' : 's'}`)
        setOpen(false); setPw(''); setPw2('')
      } catch (err) { toast(err instanceof Error ? err.message : 'Could not back it up.', 'error') }
      finally { setBusy(false) }
    }}>
      <p><strong>Back up {org.name}</strong> as an encrypted file: {items.length} item{items.length === 1 ? '' : 's'} in {readable.length} collection{readable.length === 1 ? '' : 's'}, each collection a folder.
        {colls.length > readable.length ? ` ${colls.length - readable.length} collection${colls.length - readable.length === 1 ? '' : 's'} you cannot open ${colls.length - readable.length === 1 ? 'is' : 'are'} left out.` : ''}</p>
      <p className="muted small">It opens in Import &amp; export with this password, here or on another Vault server. Keep the file and the password apart.</p>
      <div className="grid-2">
        <input type="password" autoComplete="new-password" aria-label="Backup password" placeholder="Password (12+ characters)" value={pw} onChange={(e) => setPw(e.target.value)} />
        <input type="password" autoComplete="new-password" aria-label="Backup password again" placeholder="Again" value={pw2} onChange={(e) => setPw2(e.target.value)} />
      </div>
      <div className="confirm-actions">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(false)}>Cancel</button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? <span className="spinner" /> : null}Download backup</button>
      </div>
    </form>
  )
}

/** Shown once: the recovery key of an organization just created or replaced. */
export function RecoveryKeyShown({ org, recoveryKey, onDone }: { org: string; recoveryKey: string; onDone: () => void }) {
  const [ack, setAck] = useState(false)
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="ork-title">
      <div className="modal">
        <h2 id="ork-title">Recovery key for {org}</h2>
        <p className="muted">If every owner and admin ever loses access, this key gives the organization back to a member, with every collection it covers. Keep it offline: printed, or in a safe. Vault cannot show it again and cannot recover it.</p>
        <p className="recovery-key"><code>{recoveryKey}</code></p>
        <div className="settings-actions"><CopyButton value={recoveryKey} label="Recovery key" /></div>
        <label className="check"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /><span>I have stored it somewhere safe</span></label>
        <div className="modal-actions"><button className="btn btn-primary" disabled={!ack} onClick={onDone}>Done</button></div>
      </div>
    </div>
  )
}

/** The organization recovery key (decisions/0026): the owner creates or
 *  replaces it; any member can use it to take the organization back. */
export function OrgRecovery({ org, teams }: { org: OrgView; teams: Teams }) {
  const toast = useToast()
  const [shown, setShown] = useState<string | null>(null)
  const [recovering, setRecovering] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  if (org.kind === 'direct') return null
  const colls = teams.collections.filter((c) => c.orgId === org.id)
  const covered = colls.filter((c) => c.recoveryCovered).length
  return (
    <div className="org-recovery">
      {org.role === 'owner' && org.status === 'confirmed' ? (
        <p className="muted small">
          {org.recovery ? `Recovery key created ${when(org.recovery.createdAt)} · covers ${covered} of ${colls.length} collection${colls.length === 1 ? '' : 's'}. ` : 'No recovery key yet: if every owner and admin loses access, nobody can get this organization back. '}
          <button className="link small" disabled={busy} onClick={async () => {
            if (org.recovery && !window.confirm('Replace the recovery key? The old one stops working.')) return
            setBusy(true)
            try { const r = await teams.makeRecoveryKey(org.id); setShown(r.recoveryKey); if (r.covered < r.total) toast(`${r.total - r.covered} collection(s) you cannot open are covered once someone who manages them opens the organization.`) }
            catch (err) { toast(err instanceof Error ? err.message : 'Could not create it.', 'error') }
            finally { setBusy(false) }
          }}>{org.recovery ? 'Replace the recovery key' : 'Create a recovery key'}</button>
        </p>
      ) : org.recovery ? (
        recovering ? (
          <form className="inline-form" onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            try { const r = await teams.recoverWithKey(org.id, text); toast(`You now own ${org.name}: ${r.restored} of ${r.total} collection(s) restored.`); setRecovering(false); setText('') }
            catch (err) { toast(err instanceof Error ? err.message : 'Recovery failed.', 'error') }
            finally { setBusy(false) }
          }}>
            <input aria-label="Organization recovery key" className="mono" placeholder="Recovery key" value={text} onChange={(e) => setText(e.target.value)} />
            <button type="submit" className="btn btn-danger btn-sm" disabled={busy || text.replace(/[^0-9a-z]/gi, '').length < 20}>Recover</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRecovering(false)}>Cancel</button>
          </form>
        ) : <button className="link small" onClick={() => setRecovering(true)}>Owners locked out? Recover with the recovery key…</button>
      ) : null}
      {shown ? <RecoveryKeyShown org={org.name} recoveryKey={shown} onDone={() => setShown(null)} /> : null}
    </div>
  )
}

/** After the member compares the owner's new fingerprint: pin the new key. */
async function resetOwnerPin(orgId: string, teams: Teams): Promise<void> {
  const state = session.get()
  if (!state) return
  const t = await loadTrust(orgId, state.vaultKey)
  const { ownerSigningKey: _k, ownerId: _o, requireSigned: _r, ...rest } = t
  await saveTrust(orgId, state.vaultKey, rest)
  await teams.load()
}
