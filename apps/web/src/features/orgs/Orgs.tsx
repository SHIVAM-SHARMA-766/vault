// Organizations: your fingerprint, invitations, and — for admins — members
// (with the confirm-by-fingerprint step), invitations and collections with
// who can open them. Items themselves are used from the vault.

import { useEffect, useState } from 'react'

import { fingerprintOf, loadTrust, saveTrust } from './trust.js'

import { type OrgMember, type OrgPending, type SharePermission, api } from '../../lib/api.js'
import { Link } from '../../lib/router.js'
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
  const [showKey, setShowKey] = useState<{ org: string; key: string } | null>(null)

  return (
    <Shell state={state}>
      <main className="settings">
        <div className="settings-head">
          <ol className="crumbs crumbs-admin" aria-label="Breadcrumb">
            <li><Link to="/app/">Vault</Link></li>
            <li aria-current="page">Organizations</li>
          </ol>
          <h1>Organizations</h1>
          <p className="muted">Share collections of items with people you work with. Everything shared is encrypted to each person's own key; the server cannot read it.</p>
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

        {teams.orgs.map((o) => <OrgCard key={o.id} org={o} teams={teams} selfId={state.userId} />)}

        <form className="settings-card" aria-labelledby="o-new" onSubmit={async (e) => {
          e.preventDefault()
          try { const made = await teams.createOrg(name.trim(), state.email.split('@')[0]!); setShowKey({ org: name.trim(), key: made.recoveryKey }); setName(''); toast('Organization created') }
          catch (err) { toast(err instanceof Error ? err.message : 'Could not create it.', 'error') }
        }}>
          <div className="settings-card-head"><IconPlus size={18} /><h2 id="o-new">New organization</h2></div>
          <div className="field"><label htmlFor="o-name">Name</label><input id="o-name" required maxLength={80} placeholder="e.g. Acme Finance" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <p className="hint">The name is encrypted for members. People you invite see it in their invitation before they join.</p>
          <div className="settings-actions"><button className="btn btn-primary" type="submit" disabled={!name.trim()}>Create</button></div>
        </form>

        <section className="settings-card" aria-labelledby="o-fp">
          <div className="settings-card-head"><IconShield size={18} /><h2 id="o-fp">Your fingerprint</h2></div>
          <p className="muted small">When you join an organization, an admin confirms you by checking this matches what they see. Read it to them on a call or in person — not by email or chat.</p>
          <div className="fingerprint">{teams.identity ? <><code>{teams.identity.fingerprint}</code><CopyButton value={teams.identity.fingerprint} label="Fingerprint" /></> : <span className="muted">Loading…</span>}</div>
        </section>
      </main>
      {showKey ? <RecoveryKeyShown org={showKey.org} recoveryKey={showKey.key} onDone={() => setShowKey(null)} /> : null}
    </Shell>
  )
}

function OrgCard({ org, teams, selfId }: { org: OrgView; teams: Teams; selfId: string }) {
  const toast = useToast()
  const admin = org.status === 'confirmed' && org.role !== 'member'
  const [members, setMembers] = useState<OrgMember[]>([])
  const [pending, setPending] = useState<OrgPending[]>([])
  const [confirming, setConfirming] = useState<{ m: OrgMember; fp: string } | null>(null)
  const [reconfirming, setReconfirming] = useState<{ m: OrgMember; fp: string } | null>(null)
  const [email, setEmail] = useState('')
  const [label, setLabel] = useState('')
  const [inviteGroups, setInviteGroups] = useState<string[]>([])
  const [collName, setCollName] = useState('')
  const [groupsList, setGroupsList] = useState<GroupView[]>([])
  const colls = teams.collections.filter((c) => c.orgId === org.id)

  const loadMembers = async () => {
    if (org.status !== 'confirmed') return
    const r = await api.orgs.members(await session.token(), org.id)
    setMembers(r.members); setPending(r.pending)
  }
  useEffect(() => { void loadMembers() }, [org.id, org.status])

  if (org.status !== 'confirmed') {
    return (
      <section className="settings-card">
        <div className="settings-card-head"><IconUser size={18} /><h2>{org.name}</h2><span className="pill">Waiting</span></div>
        <p className="muted small">You have joined. An admin must confirm you — by checking your fingerprint (below) — before anything is shared with you.</p>
        <OrgRecovery org={org} teams={teams} />
      </section>
    )
  }

  return (
    <section className="settings-card org-card" aria-label={org.name}>
      <div className="settings-card-head"><IconUser size={18} /><h2>{org.name}</h2>{org.kind === 'direct' ? <span className="pill" title="Made by Share with a person: just the two of you">Direct share</span> : <span className="pill pill-accent">{org.role}</span>}</div>

      {org.policyGap ? <p className="alert alert-warn"><IconAlert size={16} />{org.policyGap} Until then, its collections stay closed to you.</p> : null}
      {admin ? <PoliciesForm org={org} teams={teams} /> : <PolicySummary org={org} />}

      <h3 className="small-head">Members</h3>
      <ul className="device-list">
        {members.map((m) => (
          <li key={m.userId} className="device-row">
            <div className="device-text">
              <span className="device-name">{m.label}{m.userId === selfId ? <span className="pill">You</span> : null}</span>
              <span className="muted small">{m.role} · {m.status === 'confirmed' ? 'confirmed' : 'waiting for confirmation'}</span>
            </div>
            <div className="device-actions">
              {admin && m.status === 'accepted' ? (
                <button className="btn btn-primary btn-sm" onClick={async () => setConfirming({ m, fp: await fingerprintOf(m.publicKey, m.currentSigningKey ?? null) })}>Confirm…</button>
              ) : null}
              {admin && m.status === 'confirmed' && m.currentSigningKey && m.currentSigningKey !== m.signingPublicKey && m.userId !== selfId ? (
                <button className="btn btn-secondary btn-sm" title="Their fingerprint changed: a signing key was added" onClick={async () => setReconfirming({ m, fp: await fingerprintOf(m.publicKey, m.currentSigningKey ?? null) })}>Re-confirm…</button>
              ) : null}
              {admin && m.role !== 'owner' && m.userId !== selfId ? (
                <button className="icon-btn icon-danger" aria-label={`Remove ${m.label}`} title="Remove" onClick={async () => {
                  if (!window.confirm(`Remove ${m.label}? They lose access at once.`)) return
                  const r = await api.orgs.removeMember(await session.token(), org.id, m.userId)
                  await loadMembers(); await teams.load()
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
            <div className="device-text"><span className="device-name">{p.label}</span><span className="muted small">invited · has not joined yet{p.groups?.length ? ` · will join ${p.groups.map((g) => groupsList.find((x) => x.id === g)?.name ?? 'a group').join(', ')}` : ''}</span></div>
            {admin ? <button className="btn btn-secondary btn-sm" onClick={async () => { await api.orgs.withdraw(await session.token(), org.id, p.id); await loadMembers() }}>Withdraw</button> : null}
          </li>
        ))}
      </ul>

      {reconfirming ? (
        <div className="confirm" role="dialog" aria-label="Re-confirm member">
          <p><strong>{reconfirming.m.label}&apos;s fingerprint changed</strong> because their app added a signing key, which lets it check who shared a key with it. Re-confirm only if they read you exactly this:</p>
          <p className="fingerprint"><code>{reconfirming.fp}</code></p>
          <div className="confirm-actions">
            <button className="btn btn-secondary btn-sm" onClick={() => setReconfirming(null)}>Cancel</button>
            <button className="btn btn-primary btn-sm" onClick={async () => {
              try { await api.orgs.reconfirm(await session.token(), org.id, reconfirming.m.userId); toast(`${reconfirming.m.label} re-confirmed`); setReconfirming(null); await loadMembers(); await teams.load() }
              catch (err) { toast(err instanceof Error ? err.message : 'Could not re-confirm.', 'error') }
            }}><IconCheck size={15} />It matches — re-confirm</button>
          </div>
        </div>
      ) : null}

      {org.ownerChanged ? (
        <div className="alert alert-warn" role="alert"><IconAlert size={16} />
          <span><strong>The owner&apos;s key changed.</strong> Keys they share are not trusted until you check: ask the owner to read you their fingerprint (Organizations → Your fingerprint), and compare it with the one in this organization&apos;s member list. <button className="link" onClick={async () => { await resetOwnerPin(org.id, teams); toast('The new owner key is trusted') }}>It matches — trust the new key</button></span>
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
                setConfirming(null); await loadMembers(); await teams.load()
              }
              catch (err) { toast(err instanceof Error ? err.message : 'Could not confirm.', 'error') }
            }}><IconCheck size={15} />It matches — confirm</button>
          </div>
        </div>
      ) : null}

      {admin ? (
        <form className="inline-form org-invite" onSubmit={async (e) => {
          e.preventDefault()
          await api.orgs.invite(await session.token(), org.id, email.trim(), label.trim(), 'member', inviteGroups)
          toast('Invited. They will see it when they sign in.'); setEmail(''); setLabel(''); setInviteGroups([]); await loadMembers()
        }}>
          <input type="email" required placeholder="Email to invite" aria-label="Email to invite" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input placeholder="Name (for you)" aria-label="Name for this member" maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} />
          <button className="btn btn-secondary btn-sm" type="submit">Invite</button>
          {groupsList.length ? (
            <fieldset className="invite-groups">
              <legend className="small muted">Add to groups once confirmed</legend>
              {groupsList.map((g) => (
                <label key={g.id} className="check"><input type="checkbox" checked={inviteGroups.includes(g.id)}
                  onChange={(e) => setInviteGroups(e.target.checked ? [...inviteGroups, g.id] : inviteGroups.filter((x) => x !== g.id))} /><span>{g.name}</span></label>
              ))}
            </fieldset>
          ) : null}
        </form>
      ) : null}

      {admin ? <Activity org={org} teams={teams} members={members} /> : null}
      {admin ? <OrgBackup org={org} teams={teams} /> : null}
      <OrgRecovery org={org} teams={teams} />

      <Groups org={org} teams={teams} members={members} admin={admin} list={groupsList} setList={setGroupsList} />

      {admin ? <Requests org={org} teams={teams} members={members} /> : null}

      <h3 className="small-head">Collections</h3>
      {colls.length === 0 ? <p className="muted small">No collections yet.</p> : (
        <ul className="device-list">
          {colls.map((c) => <CollectionRow key={c.id} c={c} teams={teams} members={members} groups={groupsList} />)}
        </ul>
      )}
      {admin ? (
        <form className="inline-form" onSubmit={async (e) => {
          e.preventDefault()
          try { await teams.createCollection(org.id, collName.trim()); setCollName(''); toast('Collection created') }
          catch (err) { toast(err instanceof Error ? err.message : 'Could not create it.', 'error') }
        }}>
          <input required placeholder="New collection, e.g. Finance" aria-label="New collection name" maxLength={80} value={collName} onChange={(e) => setCollName(e.target.value)} />
          <button className="btn btn-secondary btn-sm" type="submit"><IconPlus size={14} />Add collection</button>
        </form>
      ) : null}
    </section>
  )
}

function CollectionRow({ c, teams, members, groups }: { c: CollectionView; teams: Teams; members: OrgMember[]; groups: { id: string; name: string }[] }) {
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [grants, setGrants] = useState<{ userId: string; permission: SharePermission; hidePasswords: boolean }[]>([])
  const [who, setWho] = useState('')
  const [perm, setPerm] = useState<SharePermission>('view')
  const [hide, setHide] = useState(false)
  const [group, setGroup] = useState('')
  const manage = c.permission === 'manage'
  const load = async () => setGrants((await api.orgs.access(await session.token(), c.orgId, c.id)).access)

  return (
    <li className="device-row collection-row">
      <div className="device-text">
        <span className="device-name"><IconFolder size={15} /> {c.name}
          {c.rotationNeeded ? <span className="pill pill-danger" title="Someone lost access; their copy of the key should be retired">Key rotation due</span> : null}
        </span>
        {c.untrusted ? <span className="pill pill-danger" title="Its signature did not check out against an admin you trust">Key not trusted</span> : null}
        <span className="muted small">{c.permission ? PERMISSION_LABEL[c.permission] : 'You have no access'}{c.hidePasswords ? ' · passwords hidden' : ''}{c.until ? ` · until ${when(c.until)}` : ''}</span>
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
                return <li key={g.userId}><span>{m?.label ?? 'Member'}</span><span className="muted small">{PERMISSION_LABEL[g.permission]}{g.hidePasswords ? ' · passwords hidden' : ''}</span>
                  {m && m.role !== 'owner' ? <button className="icon-btn icon-sm icon-danger" aria-label={`Remove ${m.label}'s access`} onClick={async () => { await api.orgs.revoke(await session.token(), c.orgId, c.id, g.userId); await load(); await teams.load() }}><IconX size={13} /></button> : null}
                </li>
              })}
            </ul>
            <form className="inline-form" onSubmit={async (e) => {
              e.preventDefault()
              const m = members.find((x) => x.userId === who)!
              try { await teams.grant(c.id, m.userId, m.publicKey, perm, hide); toast(`${m.label} can now ${perm} ${c.name}`); setWho(''); await load() }
              catch (err) { toast(err instanceof Error ? err.message : 'Could not share.', 'error') }
            }}>
              <select aria-label="Member" required value={who} onChange={(e) => setWho(e.target.value)}>
                <option value="">Give access to…</option>
                {members.filter((m) => m.status === 'confirmed' && !grants.some((g) => g.userId === m.userId)).map((m) => <option key={m.userId} value={m.userId}>{m.label}</option>)}
              </select>
              <select aria-label="Permission" value={perm} onChange={(e) => setPerm(e.target.value as SharePermission)}>
                {(['view', 'edit', 'manage'] as SharePermission[]).map((p) => <option key={p} value={p}>{PERMISSION_LABEL[p]}</option>)}
              </select>
              <label className="check"><input type="checkbox" checked={hide} onChange={(e) => setHide(e.target.checked)} /><span>Hide passwords</span></label>
              <button className="btn btn-secondary btn-sm" type="submit" disabled={!who}>Share</button>
            </form>
            {groups.length ? (
              <form className="inline-form" onSubmit={async (e) => {
                e.preventDefault()
                try { await teams.grantGroup(c.id, group, perm, hide); toast('Group given access'); setGroup(''); await load() }
                catch (err) { toast(err instanceof Error ? err.message : 'Could not share.', 'error') }
              }}>
                <select aria-label="Group" required value={group} onChange={(e) => setGroup(e.target.value)}>
                  <option value="">Give access to a group…</option>
                  {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
                <button className="btn btn-secondary btn-sm" type="submit" disabled={!group}>Share with group</button>
              </form>
            ) : null}
            <p className="hint">"Hide passwords" is a policy the app follows, not encryption: anyone who can open a collection holds its key.</p>
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

function Groups({ org, teams, members, admin, list, setList }: {
  org: OrgView; teams: Teams; members: OrgMember[]; admin: boolean; list: GroupView[]; setList: (l: GroupView[]) => void
}) {
  const toast = useToast()
  const [name, setName] = useState('')
  const [adding, setAdding] = useState<Record<string, string>>({})
  const load = async () => {
    const { groups } = await api.orgs.groups(await session.token(), org.id)
    const named = await Promise.all(groups.map(async (g) => ({ id: g.id, members: g.members, name: await teams.groupName(org.id, g.id, g.nameBlob) })))
    setList(named)
  }
  useEffect(() => { void load() }, [org.id, teams.collections.length])
  const label = (u: string) => members.find((m) => m.userId === u)?.label ?? 'Member'

  if (!admin && list.length === 0) return null
  return (
    <>
      <h3 className="small-head">Groups</h3>
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
    </>
  )
}

function PolicySummary({ org }: { org: OrgView }) {
  const p = org.policies
  const rules = [p.requireTwoFactor && 'two-factor sign-in', p.minPasswordScore > 0 && `a master password rated at least ${STRENGTH[p.minPasswordScore]}`, p.maxIdleMinutes && `locking after ${p.maxIdleMinutes} minutes idle`].filter(Boolean)
  return rules.length ? <p className="muted small">This organization requires {rules.join(', ')}.</p> : null
}

const STRENGTH = ['', 'Weak', 'Fair', 'Strong', 'Excellent']

function PoliciesForm({ org, teams }: { org: OrgView; teams: Teams }) {
  const toast = useToast()
  const [p, setP] = useState(org.policies)
  const [open, setOpen] = useState(false)
  if (!open) return <div className="policy-line"><PolicySummary org={org} /><button className="link small" onClick={() => setOpen(true)}>Policies…</button></div>
  return (
    <form className="policies" onSubmit={async (e) => {
      e.preventDefault()
      try { await api.orgs.setPolicies(await session.token(), org.id, p); toast('Policies saved'); setOpen(false); await teams.load() }
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
      <div className="settings-actions"><button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(false)}>Cancel</button><button type="submit" className="btn btn-primary btn-sm">Save policies</button></div>
    </form>
  )
}

const ACTION_LABEL: Record<string, string> = {
  'item.view': 'opened', 'item.reveal': 'revealed a secret in', 'item.copy': 'copied from', 'item.create': 'added', 'item.edit': 'edited', 'item.delete': 'deleted',
  'access.grant': 'gave access to', 'access.change': 'changed access to', 'access.revoke': 'removed access to', 'access.grant-group': 'gave a group access to',
  'collection.create': 'created', 'collection.delete': 'deleted', 'collection.rotate': 'rotated the key of',
  'member.invite': 'invited', 'member.confirm': 'confirmed', 'member.remove': 'removed', 'member.leave': 'left', 'policies.change': 'changed the policies',
}

function Activity({ org, teams, members }: { org: OrgView; teams: Teams; members: OrgMember[] }) {
  const [open, setOpen] = useState(false)
  const [events, setEvents] = useState<Awaited<ReturnType<typeof api.orgs.events>>['events']>([])
  const who = (u: string | null) => members.find((m) => m.userId === u)?.label ?? (u ? 'A former member' : '—')
  const item = (id: string | null) => teams.shared.find((e) => e.id === id)?.name ?? (id ? 'an item' : '')
  const coll = (id: string | null) => teams.collections.find((c) => c.id === id)?.name ?? ''
  return (
    <div className="policy-line">
      <button className="link small" onClick={async () => { if (!open) setEvents((await api.orgs.events(await session.token(), org.id)).events); setOpen(!open) }}>{open ? 'Hide activity' : 'Activity…'}</button>
      {open ? (
        <div className="audit">
          <p className="muted small">Who did what, for a year. Opening, revealing and copying are reported by each member's app.</p>
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
function Requests({ org, teams, members }: { org: OrgView; teams: Teams; members: OrgMember[] }) {
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
                      try { await teams.grant(r.collectionId, m!.userId, m!.publicKey, pick.perm, false, undefined, pick.hours || undefined); toast(`${r.label} can open ${c!.name}${pick.hours ? ` for ${DURATIONS.find(([h]) => h === pick.hours)![1].replace('For ', '')}` : ''}`); await load(); await teams.load() }
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
function OrgBackup({ org, teams }: { org: OrgView; teams: Teams }) {
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const colls = teams.collections.filter((c) => c.orgId === org.id)
  const readable = colls.filter((c) => c.key)
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
function RecoveryKeyShown({ org, recoveryKey, onDone }: { org: string; recoveryKey: string; onDone: () => void }) {
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
function OrgRecovery({ org, teams }: { org: OrgView; teams: Teams }) {
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
