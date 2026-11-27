// Emergency access: people you trust who can request a read-only view of
// your vault, opened after a waiting period unless you reject it — and the
// vaults you can request yourself. Your vault key is sealed to a contact only
// after you confirm their fingerprint.

import { useCallback, useEffect, useState } from 'react'

import { type EntryContent, Keyring, fromBase64Url, openEmergencyKey, openEntry, openVaults, sealEmergencyKey } from '@vault/crypto'

import { type EmergencyGrant, type EmergencyTrust, api } from '../../lib/api.js'
import * as session from '../../lib/session.js'
import { fingerprintOf } from '../orgs/trust.js'
import { IconAlert, IconCheck, IconShield, IconX } from '../../ui/icons.js'
import { CopyButton, useToast } from '../../ui/kit.js'
import { myIdentity } from '../orgs/model.js'
import { SecretRow, TextRow } from '../vault/fields.js'
import { when as fmtWhen } from '../../lib/format.js'

const STATUS: Record<string, string> = {
  invited: 'Invited — has not accepted', accepted: 'Accepted — confirm their fingerprint', confirmed: 'Ready', requested: 'Has requested access',
  approved: 'Has access', rejected: 'Request rejected',
}
const when = (iso: string | null) => (iso ? fmtWhen(iso) : '')

export function Emergency({ state }: { state: session.Unlocked }) {
  const toast = useToast()
  const [grants, setGrants] = useState<EmergencyGrant[]>([])
  const [trust, setTrust] = useState<{ invitations: { id: string; fromName: string; waitDays: number }[]; grants: EmergencyTrust[] }>({ invitations: [], grants: [] })
  const [form, setForm] = useState({ email: '', label: '', fromName: state.email.split('@')[0]!, waitDays: 7 })
  const [confirming, setConfirming] = useState<{ g: EmergencyGrant; fp: string } | null>(null)
  const [viewing, setViewing] = useState<{ from: string; entries: (EntryContent & { id: string })[] } | null>(null)

  const load = useCallback(async () => {
    const t = await session.token()
    const [a, b] = await Promise.all([api.emergency.mine(t), api.emergency.trusted(t)])
    setGrants(a.grants); setTrust(b)
  }, [])
  useEffect(() => { void load() }, [load])
  const act = async (fn: (t: string) => Promise<unknown>, done: string) => {
    try { await fn(await session.token()); toast(done); await load() } catch (err) { toast(err instanceof Error ? err.message : 'That did not work.', 'error') }
  }

  async function open(g: EmergencyTrust) {
    try {
      const me = await myIdentity(state.vaultKey)
      const v = await api.emergency.vault(await session.token(), g.id)
      const key = await openEmergencyKey(me.privateKey, me.publicKey, v.keyBlob, g.id)
      // Their other vaults open with their vault key, which is what was handed over.
      const ring = new Keyring(key, await openVaults(v.vaults ?? [], key))
      const entries = (await Promise.all(v.entries.map(async (e) => {
        const k = ring.keyFor(e.vaultId)
        try { return k ? { ...(await openEntry(e.id, e.blob, k)), id: e.id } : null } catch { return null }
      }))).filter((e): e is EntryContent & { id: string } => e !== null)
      entries.sort((a, b) => a.name.localeCompare(b.name))
      setViewing({ from: g.fromName, entries })
    } catch (err) { toast(err instanceof Error ? err.message : 'Could not open it.', 'error') }
  }

  return (
    <section className="settings-card" aria-labelledby="s-emergency">
      <div className="settings-card-head"><IconShield size={18} /><h2 id="s-emergency">Emergency access</h2></div>
      <p className="muted small">Choose people who can see your vault if something happens to you. They ask; if you do not reject within the waiting period, they get a read-only view. Nobody else — not the server's owner — can.</p>

      <h3 className="small-head">Your trusted contacts</h3>
      {grants.length === 0 ? <p className="muted small">None yet.</p> : (
        <ul className="device-list">
          {grants.map((g) => (
            <li key={g.id} className="device-row">
              <div className="device-text">
                <span className="device-name">{g.label}</span>
                <span className="muted small">{STATUS[g.status] ?? g.status} · waits {g.waitDays} day{g.waitDays === 1 ? '' : 's'}{g.status === 'requested' ? ` · opens ${when(g.opensAt)}` : ''}</span>
              </div>
              <div className="device-actions">
                {g.status === 'accepted' && g.granteePublicKey ? <button className="btn btn-primary btn-sm" onClick={async () => setConfirming({ g, fp: await fingerprintOf(g.granteePublicKey!, g.granteeSigningKey ?? null) })}>Confirm…</button> : null}
                {g.status === 'requested' ? <>
                  <button className="btn btn-danger btn-sm" onClick={() => act((t) => api.emergency.reject(t, g.id), 'Request rejected')}>Reject</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => act((t) => api.emergency.approve(t, g.id), 'Access approved')}>Approve now</button>
                </> : null}
                <button className="icon-btn icon-danger" aria-label={`Remove ${g.label}`} title="Remove" onClick={() => act((t) => api.emergency.revoke(t, g.id), 'Removed')}><IconX size={15} /></button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {grants.some((g) => g.status === 'requested') ? <p className="alert alert-warn"><IconAlert size={16} />Someone has requested emergency access to your vault. If you did not expect it, reject it now.</p> : null}

      {confirming ? (
        <div className="confirm" role="dialog" aria-label="Confirm contact">
          <p><strong>Confirm {confirming.g.label}</strong> only if they read you exactly this fingerprint (shown in their Settings and Organizations pages), on a call or in person:</p>
          <p className="fingerprint"><code>{confirming.fp}</code></p>
          <div className="confirm-actions">
            <button className="btn btn-secondary btn-sm" onClick={() => setConfirming(null)}>Cancel</button>
            <button className="btn btn-primary btn-sm" onClick={async () => {
              const g = confirming.g
              await act(async (t) => api.emergency.confirm(t, g.id, await sealEmergencyKey(fromBase64Url(g.granteePublicKey!), state.vaultKey, g.id)), `${g.label} can now request access`)
              setConfirming(null)
            }}><IconCheck size={15} />It matches — confirm</button>
          </div>
        </div>
      ) : null}

      <form className="emergency-form" onSubmit={async (e) => {
        e.preventDefault()
        await act((t) => api.emergency.create(t, { ...form, email: form.email.trim(), label: form.label.trim() || form.email.split('@')[0]!, fromName: form.fromName.trim() }), 'Invited. They will see it when they sign in.')
        setForm({ ...form, email: '', label: '' })
      }}>
        <div className="grid-2">
          <div className="field"><label htmlFor="em-email">Their email</label><input id="em-email" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
          <div className="field"><label htmlFor="em-label">Their name (for you)</label><input id="em-label" maxLength={80} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></div>
          <div className="field"><label htmlFor="em-from">Your name (for them)</label><input id="em-from" required maxLength={80} value={form.fromName} onChange={(e) => setForm({ ...form, fromName: e.target.value })} /></div>
          <div className="field"><label htmlFor="em-wait">Waiting period</label>
            <select id="em-wait" value={form.waitDays} onChange={(e) => setForm({ ...form, waitDays: Number(e.target.value) })}>
              {[1, 2, 3, 7, 14, 30].map((d) => <option key={d} value={d}>{d} day{d === 1 ? '' : 's'}</option>)}
            </select>
          </div>
        </div>
        <div className="settings-actions"><button className="btn btn-secondary" type="submit" disabled={!form.email.trim()}>Add trusted contact</button></div>
      </form>

      {trust.invitations.length || trust.grants.length ? <h3 className="small-head">Vaults you can request</h3> : null}
      <ul className="device-list">
        {trust.invitations.map((i) => (
          <li key={i.id} className="device-row">
            <div className="device-text"><span className="device-name">{i.fromName}</span><span className="muted small">wants you as an emergency contact · {i.waitDays}-day wait</span></div>
            <button className="btn btn-primary btn-sm" onClick={() => act((t) => api.emergency.accept(t, i.id), 'Accepted. They will confirm your fingerprint.')}>Accept</button>
          </li>
        ))}
        {trust.grants.map((g) => (
          <li key={g.id} className="device-row">
            <div className="device-text"><span className="device-name">{g.fromName}</span>
              <span className="muted small">{g.status === 'accepted' ? 'Waiting for them to confirm you' : g.status === 'requested' ? `Requested · opens ${when(g.opensAt)} unless they reject it` : g.status === 'approved' ? 'Access open' : g.status === 'rejected' ? 'Your last request was rejected' : 'You can request access'}</span></div>
            {g.status === 'confirmed' || g.status === 'rejected' ? <button className="btn btn-secondary btn-sm" onClick={() => { if (window.confirm(`Request access to ${g.fromName}'s vault? They will see the request.`)) void act((t) => api.emergency.request(t, g.id), 'Requested') }}>Request access</button> : null}
            {g.status === 'approved' ? <button className="btn btn-primary btn-sm" onClick={() => void open(g)}>Open (read only)</button> : null}
          </li>
        ))}
      </ul>
      {trust.grants.some((g) => g.status === 'accepted') ? <MyFingerprint vaultKey={state.vaultKey} /> : null}

      {viewing ? (
        <div className="emergency-view" role="dialog" aria-label={`${viewing.from}'s vault`}>
          <div className="settings-card-head"><h2>{viewing.from}'s vault</h2><span className="pill">Read only</span>
            <button className="icon-btn" aria-label="Close" onClick={() => setViewing(null)}><IconX size={16} /></button></div>
          {viewing.entries.length === 0 ? <p className="muted small">Their vault is empty.</p> : viewing.entries.map((e) => (
            <details key={e.id} className="emergency-entry"><summary>{e.name}</summary>
              <div className="fields">
                {e.username ? <TextRow label="Username" value={e.username} /> : null}
                {e.password ? <SecretRow label="Password" value={e.password} /> : null}
                {e.url ? <TextRow label="Website" value={e.url} /> : null}
                {e.notes ? <TextRow label="Notes" value={e.notes} copy={false} /> : null}
              </div>
            </details>
          ))}
        </div>
      ) : null}
    </section>
  )
}

/** Shown while someone still has to confirm you: the fingerprint they will
 *  ask you to read out, right where you need it. */
function MyFingerprint({ vaultKey }: { vaultKey: Uint8Array }) {
  const [fp, setFp] = useState('')
  useEffect(() => { void myIdentity(vaultKey).then((i) => setFp(i.fingerprint)).catch(() => {}) }, [vaultKey])
  if (!fp) return null
  return (
    <div className="my-fingerprint">
      <p className="muted small">They will check this fingerprint with you before confirming. Read it to them in person or on a call:</p>
      <div className="fingerprint"><code>{fp}</code><CopyButton value={fp} label="Fingerprint" /></div>
    </div>
  )
}
