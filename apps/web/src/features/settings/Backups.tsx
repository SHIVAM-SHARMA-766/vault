// Settings → Backups: your own backups, on your own schedule, to your own
// storage (decisions/0017). The server builds each file from ciphertext; it
// opens only with your master password, or recovery key, from that time.
// "Test restore" fetches the newest copy back and opens it here, in this
// browser, without importing anything.

import { useCallback, useEffect, useState } from 'react'

import { UnsealError } from '@vault/crypto'

import {
  type BackupDestinationInput, type BackupFrequency, type BackupSchedule, type BackupState, type CloudDrive, ApiError, api,
} from '../../lib/api.js'
import * as session from '../../lib/session.js'
import { IconAlert, IconCheck, IconClock, IconDownload, IconTrash, IconUpload } from '../../ui/icons.js'
import { Check, PasswordInput, useToast } from '../../ui/kit.js'
import { download, openPersonalBackup } from '../transfer/transfer.js'
import { when } from '../../lib/format.js'
import * as prefs from '../../lib/prefs.js'

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const FREQ_LABELS: Record<BackupFrequency, string> = { off: 'Off — only when I press Back up now', daily: 'Every day', weekly: 'Every week', monthly: 'Every month (on the 1st)' }
const size = (b: number) => (b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`)
const hourLabel = (h: number) => { const c = prefs.get().clock; return new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', ...(c === 'system' ? {} : { hour12: c === '12h' }) }) }
const CLOUD_NAMES: Record<CloudDrive, string> = { gdrive: 'Google Drive', onedrive: 'OneDrive' }
const where = (d: string) => d === 'server' ? 'On this server' : d.startsWith('s3:') ? `S3 · ${d.slice(3)}`
  : d.startsWith('webdav:') ? `WebDAV · ${d.slice(7)}`
  : d.startsWith('gdrive:') ? `Google Drive · ${d.slice(7) || 'connected'}` : d.startsWith('onedrive:') ? `OneDrive · ${d.slice(9) || 'connected'}` : d

type DestForm =
  | { type: 'server' }
  | { type: 's3'; endpoint: string; region: string; bucket: string; prefix: string; accessKey: string; secretKey: string; hasSecret: boolean }
  | { type: 'webdav'; url: string; username: string; password: string; hasSecret: boolean }
  | { type: CloudDrive; account: string; connected: boolean }

const emptyS3 = (): DestForm => ({ type: 's3', endpoint: '', region: '', bucket: '', prefix: 'vault/', accessKey: '', secretKey: '', hasSecret: false })
const emptyDav = (): DestForm => ({ type: 'webdav', url: '', username: '', password: '', hasSecret: false })

export function Backups() {
  const toast = useToast()
  const [data, setData] = useState<BackupState | null>(null)
  const [error, setError] = useState('')
  const [schedule, setSchedule] = useState<BackupSchedule | null>(null)
  const [dest, setDest] = useState<DestForm>({ type: 'server' })
  const [busy, setBusy] = useState<'' | 'save' | 'run' | 'connect'>('')
  // Back from Google or Microsoft (decisions/0024): say how it went, once.
  useEffect(() => {
    const h = new URLSearchParams(location.hash.replace(/^#/, ''))
    const ok = h.get('cloud') as CloudDrive | null, bad = h.get('cloud-error')
    if (!ok && !bad) return
    history.replaceState(null, '', location.pathname + location.search)
    if (ok && CLOUD_NAMES[ok]) toast(`${CLOUD_NAMES[ok]} connected. Backups now go there.`)
    if (bad) setError(bad)
  }, [toast])

  async function connectDrive(provider: CloudDrive) {
    setBusy('connect'); setError('')
    try { location.assign((await api.backups.connect(await session.token(), provider)).url) }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not start connecting.'); setBusy('') }
  }

  const load = useCallback(async () => {
    try {
      const d = await api.backups.get(await session.token())
      setData(d)
      setSchedule(d.schedule.frequency === 'off' && !d.runs.length
        ? { ...d.schedule, tzOffsetMinutes: -new Date().getTimezoneOffset() } : d.schedule)
      setDest(d.destination.type === 'server' ? { type: 'server' }
        : d.destination.type === 's3' ? { ...d.destination, secretKey: '', hasSecret: true }
        : d.destination.type === 'webdav' ? { ...d.destination, password: '', hasSecret: true }
        : { type: d.destination.type, account: d.destination.account, connected: true })
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your backups.')
    }
  }, [])
  useEffect(() => { void load() }, [load])

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!schedule) return
    setBusy('save'); setError('')
    try {
      const destination: BackupDestinationInput = dest.type === 'server' ? { type: 'server' }
        : dest.type === 's3' ? { type: 's3', endpoint: dest.endpoint, region: dest.region, bucket: dest.bucket, prefix: dest.prefix, accessKey: dest.accessKey, ...(dest.secretKey ? { secretKey: dest.secretKey } : {}) }
        : dest.type === 'webdav' ? { type: 'webdav', url: dest.url, username: dest.username, ...(dest.password ? { password: dest.password } : {}) }
        : { type: dest.type }
      if ((dest.type === 'gdrive' || dest.type === 'onedrive') && !dest.connected) { setError(`Connect ${CLOUD_NAMES[dest.type]} first.`); setBusy(''); return }
      // The hour is local to this browser; the server needs to know where that is.
      await api.backups.save(await session.token(), { schedule: { ...schedule, tzOffsetMinutes: -new Date().getTimezoneOffset() }, destination })
      toast('Backup settings saved')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.')
    } finally {
      setBusy('')
    }
  }

  async function runNow() {
    setBusy('run'); setError('')
    try {
      const { run } = await api.backups.run(await session.token())
      toast(`Backed up ${run.entries} item${run.entries === 1 ? '' : 's'}`)
    } catch (err) {
      setError(err instanceof ApiError && err.status === 429 ? 'You have backed up several times this hour. Try again later.'
        : err instanceof Error ? `The backup failed: ${err.message}` : 'The backup failed.')
    } finally {
      setBusy('')
      await load()
    }
  }

  if (!data || !schedule) {
    return <section className="settings-card"><p className="muted small">{error || 'Loading…'}</p></section>
  }
  const last = data.runs[0]
  const set = (p: Partial<BackupSchedule>) => setSchedule({ ...schedule, ...p })

  return (
    <>
      <section className="settings-card" aria-labelledby="b-status">
        <div className="settings-card-head"><IconClock size={18} /><h2 id="b-status">Status</h2></div>
        <dl className="facts">
          <div><dt>Last backup</dt><dd>{last ? <>{last.ok ? <span className="pill pill-ok">OK</span> : <span className="pill pill-warn">Failed</span>} {when(last.at)}</> : 'Never'}</dd></div>
          <div><dt>Next backup</dt><dd>{data.nextRunAt ? when(data.nextRunAt) : 'Not scheduled'}</dd></div>
          <div><dt>Where</dt><dd>{where(data.destination.type === 'server' ? 'server' : data.destination.type === 's3' ? `s3:${data.destination.endpoint.replace(/^https?:\/\//, '')}/${data.destination.bucket}/${data.destination.prefix}` : data.destination.type === 'webdav' ? `webdav:${data.destination.url.replace(/^https?:\/\//, '')}` : `${data.destination.type}:${data.destination.account}`)}</dd></div>
        </dl>
        {last && !last.ok ? <p className="alert alert-warn"><IconAlert size={16} /><span>The last backup failed: {last.error}</span></p> : null}
        {error ? <p className="alert alert-error"><IconAlert size={16} /><span>{error}</span></p> : null}
        <div className="settings-actions">
          <TestRestore />
          <button className="btn btn-primary" onClick={() => void runNow()} disabled={busy !== ''}>
            {busy === 'run' ? <><span className="spinner" />Backing up…</> : <><IconUpload size={16} />Back up now</>}
          </button>
        </div>
      </section>

      <form className="settings-card" aria-labelledby="b-schedule" onSubmit={save}>
        <div className="settings-card-head"><IconClock size={18} /><h2 id="b-schedule">Schedule and destination</h2></div>
        <p className="muted small">
          Each backup is your vault exactly as the server holds it: encrypted. It opens only with your master password
          from the time it was made, or your recovery key — so keep that in mind if you change your password.
        </p>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="b-freq">How often</label>
            <select id="b-freq" value={schedule.frequency} onChange={(e) => set({ frequency: e.target.value as BackupFrequency })}>
              {(Object.keys(FREQ_LABELS) as BackupFrequency[]).map((f) => <option key={f} value={f}>{FREQ_LABELS[f]}</option>)}
            </select>
          </div>
          {schedule.frequency !== 'off' ? (
            <div className="field">
              <label htmlFor="b-hour">At</label>
              <select id="b-hour" value={schedule.hour} onChange={(e) => set({ hour: Number(e.target.value) })}>
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
              </select>
            </div>
          ) : null}
          {schedule.frequency === 'weekly' ? (
            <div className="field">
              <label htmlFor="b-day">On</label>
              <select id="b-day" value={schedule.weekday} onChange={(e) => set({ weekday: Number(e.target.value) })}>
                {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="b-keep">Copies to keep</label>
            <select id="b-keep" value={schedule.keep} onChange={(e) => set({ keep: Number(e.target.value) })}>
              {[1, 3, 5, 7, 14, 30].map((k) => <option key={k} value={k}>{k} — older ones are deleted</option>)}
            </select>
            {dest.type === 'server' && schedule.keep > data.serverKeepMax ? <p className="hint">On this server, at most {data.serverKeepMax} are kept.</p> : null}
          </div>
        </div>

        <fieldset className="dest-choice">
          <legend>Where to keep them</legend>
          <label className="radio"><input type="radio" name="dest" checked={dest.type === 'server'} onChange={() => setDest({ type: 'server' })} />
            <span><strong>On this server</strong><span className="muted small">Download any copy below. Protects against deleting items by mistake, not against losing the server.</span></span></label>
          <label className="radio"><input type="radio" name="dest" disabled={!data.remoteAllowed} checked={dest.type === 's3'} onChange={() => setDest(dest.type === 's3' ? dest : emptyS3())} />
            <span><strong>My S3-compatible bucket</strong><span className="muted small">AWS S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO…</span></span></label>
          <label className="radio"><input type="radio" name="dest" disabled={!data.remoteAllowed} checked={dest.type === 'webdav'} onChange={() => setDest(dest.type === 'webdav' ? dest : emptyDav())} />
            <span><strong>My WebDAV folder</strong><span className="muted small">Nextcloud, ownCloud, a NAS</span></span></label>
          {/* Google Drive and OneDrive, offered when the operator registered their apps (decisions/0024). */}
          {(['gdrive', 'onedrive'] as const).filter((p) => data.cloud?.[p]).map((p) => (
            <label key={p} className="radio">
              <input type="radio" name="dest" disabled={!data.remoteAllowed} checked={dest.type === p}
                     onChange={() => setDest(data.destination.type === p ? { type: p, account: data.destination.account, connected: true } : { type: p, account: '', connected: false })} />
              <span><strong>{CLOUD_NAMES[p]}</strong><span className="muted small">{p === 'gdrive' ? 'Vault sees only the files it creates, in a "Vault backups" folder.' : 'Vault sees only its own app folder (Apps → Vault).'}</span></span>
            </label>
          ))}
          {!data.cloud?.gdrive || !data.cloud?.onedrive ? <p className="hint">{data.cloud?.gdrive || data.cloud?.onedrive ? 'Other cloud drives' : 'Google Drive and OneDrive'} can be reached through the WebDAV option with Nextcloud, Synology or Koofr.</p> : null}
          {!data.remoteAllowed ? <p className="hint">This server keeps personal backups on the server only.</p> : null}
        </fieldset>

        {dest.type === 's3' ? (
          <div className="grid-2">
            <Text id="b-s3-endpoint" label="Endpoint" placeholder="https://s3.eu-central-1.amazonaws.com" value={dest.endpoint} onChange={(v) => setDest({ ...dest, endpoint: v })} required />
            <Text id="b-s3-region" label="Region" placeholder="us-east-1 (auto for R2)" value={dest.region} onChange={(v) => setDest({ ...dest, region: v })} />
            <Text id="b-s3-bucket" label="Bucket" value={dest.bucket} onChange={(v) => setDest({ ...dest, bucket: v })} required />
            <Text id="b-s3-prefix" label="Folder in the bucket" value={dest.prefix} onChange={(v) => setDest({ ...dest, prefix: v })} />
            <Text id="b-s3-access" label="Access key ID" value={dest.accessKey} onChange={(v) => setDest({ ...dest, accessKey: v })} required />
            <div className="field">
              <label htmlFor="b-s3-secret">Secret access key</label>
              <PasswordInput id="b-s3-secret" autoComplete="off" required={!dest.hasSecret} placeholder={dest.hasSecret ? 'Saved — leave empty to keep it' : ''} value={dest.secretKey} onChange={(v) => setDest({ ...dest, secretKey: v })} />
            </div>
          </div>
        ) : null}
        {dest.type === 'webdav' ? (
          <div className="grid-2">
            <Text id="b-dav-url" label="Folder address" placeholder="https://cloud.example.com/remote.php/dav/files/me/Vault/" value={dest.url} onChange={(v) => setDest({ ...dest, url: v })} required />
            <Text id="b-dav-user" label="User name" value={dest.username} onChange={(v) => setDest({ ...dest, username: v })} required />
            <div className="field">
              <label htmlFor="b-dav-pw">Password or app password</label>
              <PasswordInput id="b-dav-pw" autoComplete="off" required={!dest.hasSecret} placeholder={dest.hasSecret ? 'Saved — leave empty to keep it' : ''} value={dest.password} onChange={(v) => setDest({ ...dest, password: v })} />
            </div>
          </div>
        ) : null}
        {dest.type === 'gdrive' || dest.type === 'onedrive' ? (
          <div className="cloud-connect">
            {dest.connected ? <p className="small"><IconCheck size={14} /> Connected{dest.account ? <> as <strong>{dest.account}</strong></> : null}.</p>
              : <p className="small">Vault needs your permission at {CLOUD_NAMES[dest.type]} to write backups while you are away. You will sign in to Vault again when you come back.</p>}
            <button type="button" className={`btn ${dest.connected ? 'btn-secondary' : 'btn-primary'} btn-sm`} disabled={busy !== ''} onClick={() => void connectDrive(dest.type as CloudDrive)}>
              {busy === 'connect' ? <span className="spinner" /> : null}{dest.connected ? 'Connect another account' : `Connect ${CLOUD_NAMES[dest.type]}`}
            </button>
          </div>
        ) : null}
        {dest.type === 'gdrive' || dest.type === 'onedrive' ? (
          <p className="hint">The server keeps the permission encrypted so it can back up while you are away. To end it, choose another destination here, then remove Vault from your {CLOUD_NAMES[dest.type]} account's connected apps.</p>
        ) : dest.type !== 'server' ? (
          <p className="hint">The server keeps this secret encrypted so it can back up while you are away. Give it access to this one bucket or folder and nothing else.</p>
        ) : null}

        <div className="settings-actions">
          <button className="btn btn-primary" type="submit" disabled={busy !== ''}>{busy === 'save' ? <><span className="spinner" />Saving…</> : 'Save'}</button>
        </div>
      </form>

      {data.copies.length ? (
        <section className="settings-card" aria-labelledby="b-copies">
          <div className="settings-card-head"><IconDownload size={18} /><h2 id="b-copies">Copies on this server</h2></div>
          <ul className="device-list">
            {data.copies.map((c) => (
              <li key={c.id} className="device-row">
                <div className="device-text"><span className="device-name">{when(c.at)}</span><span className="muted small">{c.name} · {size(c.bytes)}</span></div>
                <button className="btn btn-secondary btn-sm" onClick={async () => {
                  try { const f = await api.backups.copy(await session.token(), c.id); download(f.name, f.body, 'application/json') } catch { toast('Could not download that copy', 'error') }
                }}><IconDownload size={15} />Download</button>
                <button className="icon-btn" aria-label={`Delete the copy from ${when(c.at)}`} title="Delete" onClick={async () => {
                  if (!window.confirm('Delete this copy? It cannot be undone.')) return
                  try { await api.backups.deleteCopy(await session.token(), c.id); await load() } catch { toast('Could not delete that copy', 'error') }
                }}><IconTrash size={15} /></button>
              </li>
            ))}
          </ul>
          <p className="hint">To restore, download a copy and open it in Import &amp; export. Items are added; nothing is replaced.</p>
        </section>
      ) : null}

      {data.runs.length ? (
        <section className="settings-card" aria-labelledby="b-history">
          <div className="settings-card-head"><IconClock size={18} /><h2 id="b-history">History</h2></div>
          <ul className="activity-list backup-runs">
            {data.runs.map((r) => (
              <li key={r.id}>
                {r.ok ? <IconCheck size={15} /> : <IconAlert size={15} />}
                <span><strong>{r.ok ? 'Backed up' : 'Failed'}</strong> · {when(r.at)} · {where(r.destination)}{r.ok ? ` · ${r.entries} items, ${size(r.bytes)}` : ''}{r.reason === 'manual' ? ' · manual' : ''}
                  {r.error ? <span className="muted small"> — {r.error}</span> : null}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <OfflineCopy />
    </>
  )
}

/** An encrypted copy that opens without the server (C4). */
function OfflineCopy() {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  return (
    <section className="settings-card" aria-labelledby="b-offline">
      <div className="settings-card-head"><IconDownload size={18} /><h2 id="b-offline">Offline copy</h2></div>
      <p className="muted small">One file you can keep on a USB stick or another computer. It opens in any browser with your master password, with no server and no network: for when this server is down or gone. Read-only; attached files are not included.</p>
      <div className="settings-actions">
        <button className="btn btn-secondary" disabled={busy} onClick={async () => {
          setBusy(true)
          try {
            const { buildOfflineCopy } = await import('../../lib/offline.js')
            const email = session.get()?.email ?? ''
            download(`vault-offline-${new Date().toISOString().slice(0, 10)}.html`, await buildOfflineCopy(email), 'text/html')
            toast('Offline copy downloaded. It opens with the master password you have now.')
          } catch (err) { toast(err instanceof Error ? err.message : 'Could not make the offline copy.', 'error') }
          finally { setBusy(false) }
        }}>{busy ? <span className="spinner" /> : <IconDownload size={15} />}Download an offline copy</button>
      </div>
    </section>
  )
}

function Text({ id, label, value, onChange, placeholder, required }: { id: string; label: string; value: string; onChange: (v: string) => void; placeholder?: string; required?: boolean }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} value={value} placeholder={placeholder} required={required} spellCheck={false} autoComplete="off" onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}

/** Fetches the newest copy from wherever it went and opens it here. */
function TestRestore() {
  const [open, setOpen] = useState(false)
  const [secret, setSecret] = useState('')
  const [recovery, setRecovery] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  async function test(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setResult(null)
    try {
      const file = await api.backups.latest(await session.token())
      const opened = await openPersonalBackup(file.body, secret, recovery ? 'recovery' : 'password', session.get()?.email)
      setResult({ ok: true, text: `${file.name} opens: ${opened.entries.length} item${opened.entries.length === 1 ? '' : 's'} and ${opened.folders.length} folder${opened.folders.length === 1 ? '' : 's'}${opened.failed ? `; ${opened.failed} could not be opened` : ''}. Nothing was imported.` })
      setSecret('')
    } catch (err) {
      setResult({ ok: false, text: err instanceof UnsealError
        ? `That ${recovery ? 'recovery key' : 'master password'} does not open the newest backup. It needs the one you had when the backup was made.`
        : err instanceof ApiError && err.status === 404 ? 'There is no backup to test yet. Back up first.'
        : err instanceof Error ? err.message : 'The test failed.' })
    } finally {
      setBusy(false)
    }
  }

  if (!open) return <button className="btn btn-secondary" type="button" onClick={() => setOpen(true)}>Test restore…</button>
  return (
    <form className="test-restore" onSubmit={test}>
      <p className="muted small">Fetches the newest backup and opens it in this browser to prove it can be restored. Nothing is imported.</p>
      <Check checked={recovery} onChange={(v) => { setRecovery(v); setSecret('') }}>Use the recovery key instead</Check>
      <div className="field">
        <label htmlFor="b-test-secret">{recovery ? 'Recovery key' : 'Master password at the time'}</label>
        <PasswordInput id="b-test-secret" autoComplete="off" required value={secret} onChange={setSecret} />
      </div>
      {result ? <p className={`alert ${result.ok ? 'alert-ok' : 'alert-error'}`}>{result.ok ? <IconCheck size={16} /> : <IconAlert size={16} />}<span>{result.text}</span></p> : null}
      <div className="settings-actions">
        <button className="btn btn-secondary" type="button" onClick={() => { setOpen(false); setResult(null); setSecret('') }}>Close</button>
        <button className="btn btn-primary" type="submit" disabled={busy || !secret}>{busy ? <><span className="spinner" />Opening…</> : 'Test'}</button>
      </div>
    </form>
  )
}
