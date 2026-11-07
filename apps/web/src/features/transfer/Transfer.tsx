// Import & export. Importing reads another manager's export (or our own
// encrypted one) in this browser, shows what it found, and saves the items
// encrypted. Exporting builds an encrypted file by default; a plain CSV is
// offered too, behind the master password, because leaving must be easy.

import { useMemo, useState } from 'react'

import { ImportError } from '@vault/core'
import { UnsealError } from '@vault/crypto'

import { Link } from '../../lib/router.js'
import type * as session from '../../lib/session.js'
import { IconAlert, IconCheck, IconDownload, IconLock, IconUpload } from '../../ui/icons.js'
import { Check, PasswordInput, typeInfo, useToast } from '../../ui/kit.js'
import { Shell } from '../../ui/Shell.js'
import { useVault } from '../vault/model.js'
import {
  MAX_IMPORT_BYTES, type Source, checkMasterPassword, csvExport, download, encryptedExport,
  openOwnExport, plan, readSource, runImport, today,
} from './transfer.js'

const MIN_EXPORT_PASSWORD = 12

export function Transfer({ state }: { state: session.Unlocked }) {
  const vault = useVault(state.vaultKey)
  return (
    <Shell state={state}>
      <main className="settings">
        <div className="settings-head">
          <ol className="crumbs crumbs-admin" aria-label="Breadcrumb">
            <li><Link to="/app/">Vault</Link></li>
            <li aria-current="page">Import &amp; export</li>
          </ol>
          <h1>Import &amp; export</h1>
          <p className="muted">Files are read and written in this browser. Nothing leaves it unencrypted.</p>
        </div>
        <Import state={state} vault={vault} />
        <EncryptedExport vault={vault} />
        <CsvExport state={state} vault={vault} />
      </main>
    </Shell>
  )
}

type Vault = ReturnType<typeof useVault>

type Step =
  | { kind: 'pick' }
  | { kind: 'password'; text: string; name: string }
  | { kind: 'review'; source: Source; name: string }
  | { kind: 'running'; done: number; total: number }
  | { kind: 'done'; created: number; duplicates: number; tooLarge: string[] }

function Import({ state, vault }: { state: session.Unlocked; vault: Vault }) {
  const [step, setStep] = useState<Step>({ kind: 'pick' })
  const [error, setError] = useState('')
  const [exportPassword, setExportPassword] = useState('')
  const [skipDuplicates, setSkipDuplicates] = useState(true)
  const [intoFolder, setIntoFolder] = useState(false)
  const folderName = `Imported ${today()}`

  const preview = useMemo(() => step.kind === 'review'
    ? plan(step.source.candidates, vault, { skipDuplicates, ...(intoFolder ? { intoFolder: folderName } : {}) })
    : null, [step, vault.entries, vault.folders, skipDuplicates, intoFolder])

  const byType = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of preview?.entries ?? []) m.set(e.type, (m.get(e.type) ?? 0) + 1)
    return [...m]
  }, [preview])

  async function pick(file: File | undefined) {
    setError('')
    if (!file) return
    if (file.size > MAX_IMPORT_BYTES) { setError('That file is larger than 5 MB, which is more than any password export should be.'); return }
    try {
      const text = await file.text()
      const read = readSource(text)
      if ('needsPassword' in read) setStep({ kind: 'password', text, name: file.name })
      else if (!read.candidates.length) setError('The file was read, but it holds no items.')
      else setStep({ kind: 'review', source: read, name: file.name })
    } catch (err) {
      setError(err instanceof ImportError ? err.message : 'The file could not be read.')
    }
  }

  async function unlockExport(e: React.FormEvent) {
    e.preventDefault()
    if (step.kind !== 'password') return
    setError('')
    try {
      const source = await openOwnExport(step.text, exportPassword)
      setExportPassword('')
      setStep({ kind: 'review', source, name: step.name })
    } catch (err) {
      setError(err instanceof UnsealError ? 'That export password is wrong, or the file has been changed.' : err instanceof Error ? err.message : 'Could not open the export.')
    }
  }

  async function start() {
    if (!preview) return
    const duplicates = preview.duplicates
    setError('')
    setStep({ kind: 'running', done: 0, total: preview.entries.length })
    try {
      const r = await runImport(preview, state.vaultKey, (done, total) => setStep({ kind: 'running', done, total }))
      await vault.load()
      setStep({ kind: 'done', created: r.created, duplicates, tooLarge: r.tooLarge })
    } catch (err) {
      await vault.load()
      setError(`${err instanceof Error ? err.message : 'The import stopped.'} Items saved before the error are in your vault; importing the file again skips them as duplicates.`)
      setStep({ kind: 'pick' })
    }
  }

  const reset = () => { setStep({ kind: 'pick' }); setError(''); setExportPassword('') }

  return (
    <section className="settings-card" aria-labelledby="s-import">
      <div className="settings-card-head"><IconUpload size={18} /><h2 id="s-import">Import</h2></div>

      {step.kind === 'pick' ? (
        <>
          <p className="muted small">
            From Chrome, Edge, Brave, Firefox, Safari, Bitwarden (JSON or CSV), 1Password, LastPass, KeePass, Zoho Vault,
            or a Vault encrypted export. Other CSV files work when their columns have recognisable names.
          </p>
          <label className="file-drop">
            <input type="file" accept=".csv,.json,.txt,text/csv,application/json" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = '' }} />
            <IconUpload size={20} />
            <span><strong>Choose an export file</strong><span className="muted small">CSV or JSON, up to 5 MB</span></span>
          </label>
          <p className="hint">After importing, delete the export file: it holds your passwords in plain text.</p>
        </>
      ) : null}

      {step.kind === 'password' ? (
        <form onSubmit={unlockExport}>
          <p className="muted small"><strong>{step.name}</strong> is a Vault encrypted export. Enter the password it was exported with.</p>
          <div className="field">
            <label htmlFor="imp-pw">Export password</label>
            <PasswordInput id="imp-pw" autoComplete="off" required autoFocus value={exportPassword} onChange={setExportPassword} />
          </div>
          <div className="settings-actions">
            <button type="button" className="btn btn-secondary" onClick={reset}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={!exportPassword}>Open export</button>
          </div>
        </form>
      ) : null}

      {step.kind === 'review' && preview ? (
        <>
          <p className="muted small"><strong>{step.name}</strong> was read as <strong>{step.source.format}</strong>: {step.source.candidates.length} item{step.source.candidates.length === 1 ? '' : 's'}.</p>
          {step.source.warnings.map((w) => <p key={w} className="alert alert-warn"><IconAlert size={16} />{w}</p>)}
          <div className="import-summary">
            {byType.map(([type, n]) => { const t = typeInfo(type as never); return <span key={type} className="badge"><t.Icon size={13} />{n} {n === 1 ? t.label.toLowerCase() : t.plural.toLowerCase()}</span> })}
            {preview.folders.length ? <span className="badge badge-folder">{preview.folders.length} new folder{preview.folders.length === 1 ? '' : 's'}</span> : null}
          </div>
          <Check checked={skipDuplicates} onChange={setSkipDuplicates}>
            Skip items already in the vault (same name, username and website){preview.duplicates ? ` — ${preview.duplicates} found` : ''}
          </Check>
          <Check checked={intoFolder} onChange={setIntoFolder}>Put everything in a new folder, “{folderName}”</Check>
          <div className="settings-actions">
            <button className="btn btn-secondary" onClick={reset}>Cancel</button>
            <button className="btn btn-primary" onClick={() => void start()} disabled={!preview.entries.length}>
              Import {preview.entries.length} item{preview.entries.length === 1 ? '' : 's'}
            </button>
          </div>
        </>
      ) : null}

      {step.kind === 'running' ? (
        <div className="import-progress" role="status" aria-live="polite">
          <p className="muted small">Encrypting and saving… {step.done} of {step.total}</p>
          <div className="progress"><div style={{ width: `${step.total ? Math.round((step.done / step.total) * 100) : 0}%` }} /></div>
        </div>
      ) : null}

      {step.kind === 'done' ? (
        <>
          <p className="alert alert-ok" role="status"><IconCheck size={16} />
            Imported {step.created} item{step.created === 1 ? '' : 's'}{step.duplicates ? `; ${step.duplicates} duplicate${step.duplicates === 1 ? '' : 's'} skipped` : ''}.
          </p>
          {step.tooLarge.length ? <p className="alert alert-warn"><IconAlert size={16} />Too large to store, not imported: {step.tooLarge.join(', ')}</p> : null}
          <p className="hint">Now delete the export file you imported from.</p>
          <div className="settings-actions">
            <button className="btn btn-secondary" onClick={reset}>Import another file</button>
            <Link to="/app/" className="btn btn-primary">Go to the vault</Link>
          </div>
        </>
      ) : null}

      {error ? <p className="alert alert-error"><IconAlert size={16} />{error}</p> : null}
    </section>
  )
}

function EncryptedExport({ vault }: { vault: Vault }) {
  const toast = useToast()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (password.length < MIN_EXPORT_PASSWORD) { setError(`Use at least ${MIN_EXPORT_PASSWORD} characters.`); return }
    if (password !== confirm) { setError('The passwords do not match.'); return }
    setBusy(true)
    try {
      download(`vault-export-${today()}.json`, await encryptedExport(vault.entries, vault.folders, password), 'application/json')
      setPassword(''); setConfirm('')
      toast('Encrypted export downloaded')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not export.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="settings-card" onSubmit={submit} aria-labelledby="s-export">
      <div className="settings-card-head"><IconDownload size={18} /><h2 id="s-export">Encrypted export</h2></div>
      <p className="muted small">
        A backup of every item and folder, encrypted with a password you choose here. Keep the password apart from the
        file: without it the file cannot be opened, by you or anyone else. Import it on any Vault server.
      </p>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="ex-pw">Export password</label>
          <PasswordInput id="ex-pw" autoComplete="new-password" required value={password} onChange={setPassword} />
        </div>
        <div className="field">
          <label htmlFor="ex-confirm">Confirm export password</label>
          <PasswordInput id="ex-confirm" autoComplete="new-password" required value={confirm} onChange={setConfirm} />
        </div>
      </div>
      {error ? <p className="alert alert-error"><IconAlert size={16} />{error}</p> : null}
      <div className="settings-actions">
        <button className="btn btn-primary" type="submit" disabled={busy || vault.loading || !password || !confirm}>
          {busy ? <><span className="spinner" />Encrypting…</> : `Export ${vault.entries.length} item${vault.entries.length === 1 ? '' : 's'}`}
        </button>
      </div>
    </form>
  )
}

function CsvExport({ state, vault }: { state: session.Unlocked; vault: Vault }) {
  const toast = useToast()
  const [password, setPassword] = useState('')
  const [understood, setUnderstood] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      if (!(await checkMasterPassword(state, password))) { setError('That master password is wrong.'); return }
      download(`vault-export-${today()}.csv`, csvExport(vault.entries, vault.folders), 'text/csv')
      setPassword(''); setUnderstood(false)
      toast('CSV downloaded. Delete it once you are done with it.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not export.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="settings-card" onSubmit={submit} aria-labelledby="s-csv">
      <div className="settings-card-head"><IconLock size={18} /><h2 id="s-csv">Plain CSV export</h2></div>
      <p className="muted small">
        For moving to another password manager. The CSV uses Bitwarden’s layout, which most managers import. Cards,
        identities and other types become secure notes with their fields listed.
      </p>
      <p className="alert alert-warn"><IconAlert size={16} />The file is not encrypted. Anyone who gets it can read every password in it.</p>
      <div className="field">
        <label htmlFor="csv-pw">Master password</label>
        <PasswordInput id="csv-pw" autoComplete="current-password" required value={password} onChange={setPassword} />
      </div>
      <Check checked={understood} onChange={setUnderstood}>I understand this file holds my passwords in plain text</Check>
      {error ? <p className="alert alert-error"><IconAlert size={16} />{error}</p> : null}
      <div className="settings-actions">
        <button className="btn btn-danger" type="submit" disabled={busy || vault.loading || !password || !understood}>
          {busy ? <><span className="spinner" />Checking…</> : 'Download CSV'}
        </button>
      </div>
    </form>
  )
}
