// The first-run setup wizard (A2): the few decisions a new server needs, one
// at a time — its name and support address, who may join, sign-in rules,
// whether mail and backups work — then people to invite. Every step saves
// through the same routes as the panel's own cards, and can be skipped.

import { useEffect, useState } from 'react'

import { type AdminOverview, type BackupStatus, type InstanceProfile, type RegistrationMode, type ServerPolicy, api } from '../../lib/api.js'
import { refresh as refreshInstance } from '../../lib/instance.js'
import * as session from '../../lib/session.js'
import { IconAlert, IconCheck } from '../../ui/icons.js'
import { useToast } from '../../ui/kit.js'

const STEPS = ['Name', 'Who can join', 'Sign-in rules', 'Mail and backups', 'People'] as const

export const WIZARD_KEY = 'vault.setup-wizard.done'
export const wizardDone = (): boolean => { try { return localStorage.getItem(WIZARD_KEY) === '1' } catch { return false } }
const markDone = () => { try { localStorage.setItem(WIZARD_KEY, '1') } catch { /* shown again next time */ } }

export function SetupWizard({ data, onClose, onInvite }: { data: AdminOverview; onClose: () => void; onInvite: () => void }) {
  const toast = useToast()
  const [step, setStep] = useState(0)
  const [profile, setProfile] = useState<InstanceProfile | null>(null)
  const [policy, setPolicy] = useState<ServerPolicy | null>(null)
  const [mode, setMode] = useState<RegistrationMode>(data.registration)
  const [backup, setBackup] = useState<BackupStatus | null>(null)
  const [testTo, setTestTo] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void (async () => {
      const t = await session.token()
      const [s, b] = await Promise.all([api.admin.settings(t), api.admin.backup(t).catch(() => null)])
      setProfile(s.profile); setPolicy(s.policy); setBackup(b)
    })().catch(() => toast('Could not load the current settings.', 'error'))
  }, [])

  const finish = () => { markDone(); onClose() }
  async function save(action: (t: string) => Promise<unknown>, next = true) {
    setBusy(true)
    try { await action(await session.token()); if (next) setStep((s) => s + 1) }
    catch (err) { toast(err instanceof Error ? err.message : 'Could not save.', 'error') }
    finally { setBusy(false) }
  }

  if (!profile || !policy) return null
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="wiz-title" onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
      <div className="modal wizard">
        <p className="muted small">Set up this server · step {step + 1} of {STEPS.length}</p>
        <ol className="wizard-steps" aria-label="Steps">
          {STEPS.map((s, i) => <li key={s} className={i === step ? 'is-current' : i < step ? 'is-done' : ''} aria-current={i === step ? 'step' : undefined}>{i < step ? <IconCheck size={12} /> : null}{s}</li>)}
        </ol>

        {step === 0 ? (
          <form onSubmit={(e) => { e.preventDefault(); void save(async (t) => { await api.admin.setProfile(t, profile); refreshInstance() }) }}>
            <h2 id="wiz-title">What is this server called?</h2>
            <p className="muted">Shown on the sign-in page. The support address is where people's replies to Vault's emails go.</p>
            <div className="field"><label htmlFor="wiz-name">Server name</label>
              <input id="wiz-name" autoFocus maxLength={60} placeholder="e.g. Acme Vault" value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} /></div>
            <div className="field"><label htmlFor="wiz-email">Support email</label>
              <input id="wiz-email" type="email" maxLength={254} placeholder="it-help@example.com" value={profile.supportEmail} onChange={(e) => setProfile({ ...profile, supportEmail: e.target.value })} /></div>
            <Nav busy={busy} onSkip={() => setStep(1)} />
          </form>
        ) : null}

        {step === 1 ? (
          <form onSubmit={(e) => { e.preventDefault(); void save((t) => api.admin.setRegistration(t, mode)) }}>
            <h2 id="wiz-title">Who can create an account?</h2>
            <div className="choice-list" role="radiogroup" aria-labelledby="wiz-title">
              {([['invite', 'People I invite', 'Recommended. Each person gets a code that works once.'], ['closed', 'Nobody for now', 'Turn this on later from the panel.'], ['open', 'Anyone who finds this address', 'Only for a server on a private network.']] as const).map(([m, label, hint]) => (
                <label key={m} className={`choice ${mode === m ? 'is-on' : ''}`}>
                  <input type="radio" name="wiz-mode" checked={mode === m} onChange={() => setMode(m)} />
                  <span><strong>{label}</strong><span className="muted small">{hint}</span></span>
                </label>
              ))}
            </div>
            {data.registrationForcedOpen ? <p className="alert alert-warn"><IconAlert size={16} /><span>Registration is forced open on the host (<code>ALLOW_REGISTRATION</code>).</span></p> : null}
            <Nav busy={busy} onBack={() => setStep(0)} onSkip={() => setStep(2)} />
          </form>
        ) : null}

        {step === 2 ? (
          <form onSubmit={(e) => { e.preventDefault(); void save((t) => api.admin.setPolicy(t, policy)) }}>
            <h2 id="wiz-title">Sign-in rules for everyone</h2>
            <label className="check"><input type="checkbox" checked={policy.requireTwoFactor} onChange={(e) => setPolicy({ ...policy, requireTwoFactor: e.target.checked })} /><span>Require two-factor sign-in</span></label>
            <label className="check"><input type="checkbox" checked={policy.minPasswordScore >= 3} onChange={(e) => setPolicy({ ...policy, minPasswordScore: e.target.checked ? 3 : 0 })} /><span>Require a strong master password</span></label>
            <label className="check"><input type="checkbox" checked={policy.maxIdleMinutes !== null} onChange={(e) => setPolicy({ ...policy, maxIdleMinutes: e.target.checked ? 15 : null })} /><span>Lock everyone&apos;s vault after 15 idle minutes at most</span></label>
            <p className="hint">Nobody is locked out by these: anyone who misses one is told what to do. More rules are under Overview → Policies.</p>
            <Nav busy={busy} onBack={() => setStep(1)} onSkip={() => setStep(3)} />
          </form>
        ) : null}

        {step === 3 ? (
          <div>
            <h2 id="wiz-title">Mail and backups</h2>
            <ul className="wizard-status">
              <li className={data.mail ? 'is-ok' : 'is-warn'}>
                <strong>Mail</strong> {data.mail ? 'is set up.' : 'is off. Invitations show a code to send yourself. Set SMTP_HOST and MAIL_FROM on the host to email them (docs/configuration.md).'}
                {data.mail ? (
                  <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void save((t) => api.admin.testMail(t, testTo).then(() => toast(`Test sent to ${testTo}`)), false) }}>
                    <input type="email" required placeholder="Send a test to…" aria-label="Test email address" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
                    <button className="btn btn-secondary btn-sm" type="submit" disabled={busy}>Send test</button>
                  </form>
                ) : null}
              </li>
              <li className={backup?.enabled ? 'is-ok' : 'is-warn'}>
                <strong>Backups</strong> {backup?.enabled ? `run every ${backup.intervalHours} hours, to ${backup.destinations.map((d) => d.where).join(' and ')}.` : 'are off. Set BACKUP_PASSPHRASE and BACKUP_DIR or BACKUP_S3_* on the host (docs/INSTALL.md), and keep the passphrase somewhere other than this server.'}
              </li>
            </ul>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setStep(2)}>Back</button>
              <button type="button" className="btn btn-primary" onClick={() => setStep(4)}>Next</button>
            </div>
          </div>
        ) : null}

        {step === 4 ? (
          <div>
            <h2 id="wiz-title">Invite your people</h2>
            <p className="muted">Paste a list of addresses (or a spreadsheet column) to invite everyone at once, or invite one person at a time. You can also turn on two-factor sign-in for your own account now, under Settings → Security.</p>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={finish}>Done for now</button>
              <button type="button" className="btn btn-primary" onClick={() => { finish(); onInvite() }}>Go to Invitations</button>
            </div>
          </div>
        ) : null}

        {step < 4 ? <button type="button" className="link small wizard-later" onClick={finish}>Finish later — the checklist on Overview keeps track</button> : null}
      </div>
    </div>
  )
}

function Nav({ busy, onBack, onSkip }: { busy: boolean; onBack?: () => void; onSkip: () => void }) {
  return (
    <div className="modal-actions">
      {onBack ? <button type="button" className="btn btn-secondary" onClick={onBack}>Back</button> : null}
      <button type="button" className="btn btn-ghost" onClick={onSkip}>Skip</button>
      <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? <span className="spinner" /> : null}Save and continue</button>
    </div>
  )
}
