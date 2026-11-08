// Showing and editing one field of an entry, by its kind (packages/core's
// item model). Secrets stay masked until revealed; copying a secret clears
// the clipboard after thirty seconds (ui/kit).

import { useEffect, useState } from 'react'

import { generateTotp } from '@vault/crypto'
import { type FieldSpec, cardBrand, formatCardNumber, formatDate, isPast } from '@vault/core'

import { IconExternal, IconEye, IconEyeOff } from '../../ui/icons.js'
import { CopyButton, Generator, StrengthMeter } from '../../ui/kit.js'

// ── Display ─────────────────────────────────────────────────────────────────

export function FieldView({ spec, value, entryType }: { spec: FieldSpec; value: string; entryType: string }) {
  if (!value) return null
  switch (spec.kind) {
    case 'secret':
      return <SecretRow label={spec.label} value={value} strength={spec.key === 'password'}
                        display={entryType === 'card' && spec.key === 'number' ? formatCardNumber : undefined}
                        badge={entryType === 'card' && spec.key === 'number' ? cardBrand(value) : null} />
    case 'secretBlock':
      return <SecretBlockRow label={spec.label} value={value} />
    case 'multiline':
      return <BlockRow label={spec.label} value={value} />
    case 'totp':
      return <TotpRow secret={value} />
    case 'url':
      return <UrlRow label={spec.label} value={value} />
    case 'date':
      return <DateRow label={spec.label} value={value} expiry={spec.key === 'expires'} />
    case 'select':
      return <TextRow label={spec.label} value={spec.options?.find(([k]) => k === value)?.[1] ?? value} copy={false} />
    default:
      return <TextRow label={spec.label} value={value} />
  }
}

function DateRow({ label, value, expiry }: { label: string; value: string; expiry: boolean }) {
  const expired = expiry && isPast(value)
  return (
    <div className="field-row">
      <span className="field-label">{label}{expired ? <span className="pill pill-danger field-badge">Expired</span> : null}</span>
      <div className="field-value"><span className="truncate">{formatDate(value)}</span></div>
    </div>
  )
}

export function TextRow({ label, value, copy = true }: { label: string; value: string; copy?: boolean }) {
  return (
    <div className="field-row">
      <span className="field-label">{label}</span>
      <div className="field-value">
        <span className="truncate">{value}</span>
        {copy ? <span className="field-tools"><CopyButton value={value} label={label} /></span> : null}
      </div>
    </div>
  )
}

export function SecretRow({ label, value, strength, display, badge }: {
  label: string; value: string; strength?: boolean; display?: ((v: string) => string) | undefined; badge?: string | null
}) {
  const [revealed, setRevealed] = useState(false)
  return (
    <div className="field-row">
      <span className="field-label">{label}{badge ? <span className="pill field-badge">{badge}</span> : null}</span>
      <div className="field-value">
        <span className="mono truncate">{revealed ? (display ? display(value) : value) : '•'.repeat(Math.min(value.length, 16))}</span>
        <span className="field-tools">
          <button type="button" className="icon-btn" onClick={() => setRevealed(!revealed)}
                  title={revealed ? 'Hide' : 'Reveal'} aria-label={revealed ? `Hide ${label}` : `Reveal ${label}`}>
            {revealed ? <IconEyeOff size={16} /> : <IconEye size={16} />}
          </button>
          <CopyButton value={value} label={label} />
        </span>
      </div>
      {strength ? <StrengthMeter password={value} /> : null}
    </div>
  )
}

function BlockRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="field-row">
      <div className="label-row"><span className="field-label">{label}</span><CopyButton value={value} label={label} /></div>
      <pre className="field-block">{value}</pre>
    </div>
  )
}

function SecretBlockRow({ label, value }: { label: string; value: string }) {
  const [revealed, setRevealed] = useState(false)
  return (
    <div className="field-row">
      <div className="label-row">
        <span className="field-label">{label}</span>
        <span className="field-tools">
          <button type="button" className="icon-btn" onClick={() => setRevealed(!revealed)} aria-label={revealed ? `Hide ${label}` : `Reveal ${label}`}>
            {revealed ? <IconEyeOff size={16} /> : <IconEye size={16} />}
          </button>
          <CopyButton value={value} label={label} />
        </span>
      </div>
      {revealed ? <pre className="field-block mono">{value}</pre> : <p className="muted small">Hidden — {value.split('\n').length} line{value.includes('\n') ? 's' : ''}</p>}
    </div>
  )
}

function UrlRow({ label, value }: { label: string; value: string }) {
  const href = value.includes('://') ? value : `https://${value}`
  const safe = /^https?:\/\//i.test(href) ? href : ''
  return (
    <div className="field-row">
      <span className="field-label">{label}</span>
      <div className="field-value">
        <span className="truncate">{value}</span>
        <span className="field-tools">
          {safe ? (
            <a className="icon-btn" href={safe} target="_blank" rel="noopener noreferrer" title="Open website" aria-label="Open website">
              <IconExternal size={16} />
            </a>
          ) : null}
          <CopyButton value={value} label={label} />
        </span>
      </div>
    </div>
  )
}

function TotpRow({ secret }: { secret: string }) {
  const [code, setCode] = useState<{ code: string; secondsRemaining: number } | null>(null)
  const [bad, setBad] = useState(false)
  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const next = await generateTotp(secret.replace(/\s+/g, ''))
        if (alive) setCode(next)
      } catch {
        if (alive) setBad(true)
      }
    }
    void tick()
    const t = setInterval(tick, 1000)
    return () => { alive = false; clearInterval(t) }
  }, [secret])
  return (
    <div className="field-row">
      <span className="field-label">One-time code</span>
      <div className="field-value">
        {bad ? <span className="muted">The stored key is not valid Base32</span> : code ? (
          <>
            <span className="mono totp">{code.code.slice(0, 3)} {code.code.slice(3)}</span>
            <span className="field-tools">
              <span className={`totp-timer ${code.secondsRemaining <= 5 ? 'totp-low' : ''}`}>{code.secondsRemaining}s</span>
              <CopyButton value={code.code} label="Code" />
            </span>
          </>
        ) : <span className="muted">…</span>}
      </div>
    </div>
  )
}

// ── Editing ─────────────────────────────────────────────────────────────────

export function FieldInput({ spec, value, onChange }: { spec: FieldSpec; value: string; onChange: (v: string) => void }) {
  const id = `f-${spec.key}`
  const [shown, setShown] = useState(false)
  const [gen, setGen] = useState(false)

  if (spec.kind === 'multiline' || spec.kind === 'secretBlock') {
    return (
      <div className="field">
        <label htmlFor={id}>{spec.label}</label>
        <textarea id={id} rows={spec.kind === 'secretBlock' ? 6 : 3} spellCheck={false}
                  className={spec.kind === 'secretBlock' ? 'mono' : ''} placeholder={spec.placeholder}
                  value={value} onChange={(e) => onChange(e.target.value)} />
      </div>
    )
  }
  if (spec.kind === 'date') {
    return (
      <div className="field">
        <label htmlFor={id}>{spec.label}</label>
        <input id={id} type="date" value={value} onChange={(e) => onChange(e.target.value)} />
      </div>
    )
  }
  if (spec.kind === 'select') {
    return (
      <div className="field">
        <label htmlFor={id}>{spec.label}</label>
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {(spec.options ?? []).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>
    )
  }
  if (spec.kind === 'secret') {
    return (
      <div className="field">
        <div className="label-row">
          <label htmlFor={id}>{spec.label}</label>
          {spec.generate ? <button type="button" className="link" onClick={() => setGen(!gen)}>{gen ? 'Hide generator' : 'Generate'}</button> : null}
        </div>
        <div className="input-wrap">
          <input id={id} type={shown ? 'text' : 'password'} autoComplete="new-password" spellCheck={false} className="mono"
                 placeholder={spec.placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
          <button type="button" className="input-affix" onClick={() => setShown(!shown)} aria-label={shown ? `Hide ${spec.label}` : `Show ${spec.label}`}>
            {shown ? <IconEyeOff size={16} /> : <IconEye size={16} />}
          </button>
        </div>
        {spec.key === 'password' ? <StrengthMeter password={value} /> : null}
        {gen ? <Generator onUse={(p) => { onChange(p); setShown(true); setGen(false) }} /> : null}
      </div>
    )
  }
  return (
    <div className="field">
      <label htmlFor={id}>{spec.label}</label>
      <input id={id} autoComplete="off" spellCheck={false}
             type={spec.kind === 'email' ? 'email' : spec.kind === 'phone' ? 'tel' : 'text'}
             inputMode={spec.kind === 'url' ? 'url' : spec.kind === 'phone' ? 'tel' : spec.kind === 'expiry' ? 'numeric' : undefined}
             className={spec.kind === 'totp' ? 'mono' : ''} maxLength={spec.kind === 'expiry' ? 5 : undefined}
             placeholder={spec.placeholder} value={value}
             onChange={(e) => onChange(spec.kind === 'expiry' ? formatExpiry(e.target.value) : e.target.value)} />
    </div>
  )
}

function formatExpiry(v: string): string {
  const d = v.replace(/\D/g, '').slice(0, 4)
  return d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d
}
