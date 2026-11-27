// Admin API tokens and SCIM provisioning (admin console phase 5): for
// scripts and for a directory (Entra ID, Okta, JumpCloud) to keep accounts in
// step. Owners make them; the token is shown once.

import { useState } from 'react'

import { api } from '../../lib/api.js'
import * as session from '../../lib/session.js'
import { IconKey, IconTrash } from '../../ui/icons.js'
import { CopyButton, useToast } from '../../ui/kit.js'
import { ago, run, useAdminData, when } from './common.js'

const SCOPE_HELP: Record<string, string> = {
  'overview.read': 'Read the overview counts',
  'users.read': 'List and read accounts',
  'users.write': 'Disable, enable, sign out, offboard, delete accounts (never admins or owners)',
  'invites.read': 'List invitations',
  'invites.write': 'Create and withdraw invitations',
  'audit.read': 'Read and export the audit log, and reports',
  scim: 'SCIM 2.0 provisioning from a directory (Entra ID, Okta, JumpCloud)',
}

const loadTokens = (t: string) => api.admin.tokens(t)

export function ApiTokensCard() {
  const toast = useToast()
  const { data, error, reload } = useAdminData(loadTokens)
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<Set<string>>(new Set(['scim']))
  const [days, setDays] = useState<string>('90')
  const [shown, setShown] = useState<string | null>(null)
  const scimUrl = `${location.origin}/api/scim/v2`

  async function create(e: React.FormEvent) {
    e.preventDefault()
    try {
      const r = await api.admin.createToken(await session.token(), { name: name.trim(), scopes: [...scopes], days: days === 'never' ? null : Number(days) })
      setShown(r.token); setName(''); await reload()
    } catch (err) { toast(err instanceof Error ? err.message : 'Could not make the token.', 'error') }
  }

  return (
    <div className="admin-card api-tokens">
      <div className="admin-card-head"><IconKey size={16} /><h2>API tokens and SCIM</h2></div>
      <p className="muted small">For scripts, and for your directory to provision people. A token acts on accounts and invitations like staff do, within the scopes you give it; it can never change roles or settings, manage tokens, or open a vault.</p>
      {error ? <p className="alert alert-error">{error}</p> : null}

      <div className="scim-url">
        <span className="muted small">SCIM base URL (use a token with the <code>scim</code> scope as the bearer token):</span>
        <div className="recovery-key"><code>{scimUrl}</code><CopyButton value={scimUrl} label="SCIM URL" /></div>
      </div>

      {shown ? (
        <div className="issued">
          <p><strong>Copy the token now.</strong> It is shown once; only a fingerprint of it is kept.</p>
          <div className="recovery-key"><code>{shown}</code><CopyButton value={shown} label="API token" /></div>
          <button className="link" onClick={() => setShown(null)}>Done</button>
        </div>
      ) : null}

      <form className="token-form" onSubmit={(e) => void create(e)}>
        <div className="field"><label htmlFor="tok-name">Name</label><input id="tok-name" maxLength={60} required placeholder="e.g. Entra ID provisioning" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <fieldset className="pw-group">
          <legend>Scopes</legend>
          {(data?.scopes ?? Object.keys(SCOPE_HELP)).map((s) => (
            <label key={s} className="check">
              <input type="checkbox" checked={scopes.has(s)} onChange={(e) => setScopes((cur) => { const n = new Set(cur); if (e.target.checked) n.add(s); else n.delete(s); return n })} />
              <span><code>{s}</code> · {SCOPE_HELP[s] ?? s}</span>
            </label>
          ))}
        </fieldset>
        <div className="field"><label htmlFor="tok-days">Expires</label>
          <select id="tok-days" value={days} onChange={(e) => setDays(e.target.value)}>
            <option value="30">In 30 days</option><option value="90">In 90 days</option><option value="365">In a year</option><option value="never">Never</option>
          </select>
        </div>
        <button className="btn btn-primary btn-sm" type="submit" disabled={!name.trim() || scopes.size === 0}>Make token</button>
      </form>

      {data && data.tokens.length ? (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Name</th><th>Scopes</th><th>Expires</th><th>Last used</th><th aria-label="Actions" /></tr></thead>
            <tbody>{data.tokens.map((t) => (
              <tr key={t.id}>
                <td className="strong">{t.name}<br /><code className="acct-id">vault_pat_{t.id}…</code></td>
                <td>{t.scopes.join(', ')}</td>
                <td>{t.expiresAt ? when(t.expiresAt) : 'never'}</td>
                <td>{t.lastUsedAt ? ago(t.lastUsedAt) : 'never'}</td>
                <td><button className="icon-btn icon-danger" aria-label={`Revoke ${t.name}`} title="Revoke" onClick={() => {
                  if (window.confirm(`Revoke "${t.name}"? Anything using it stops working at once.`)) void run(toast, (tok) => api.admin.revokeToken(tok, t.id), 'Token revoked').then(() => reload())
                }}><IconTrash size={15} /></button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : null}
    </div>
  )
}
