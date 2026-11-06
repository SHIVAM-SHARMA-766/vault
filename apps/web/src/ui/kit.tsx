// Small shared pieces: toasts, copy-to-clipboard, password fields, the
// generator, and the strength meter. Nothing here touches the network.

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

import type { EntryType } from '@vault/crypto'

import {
  IconAlert, IconBank, IconCard, IconCheck, IconCopy, IconEye, IconEyeOff, IconKey,
  IconNote, IconRefresh, IconTerminal, IconUser, IconWifi,
} from './icons.js'

// ── Toasts ────────────────────────────────────────────────────────────────

interface Toast { id: number; text: string; tone: 'ok' | 'error' }
const ToastContext = createContext<(text: string, tone?: Toast['tone']) => void>(() => {})

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const next = useRef(0)

  const push = useCallback((text: string, tone: Toast['tone'] = 'ok') => {
    const id = ++next.current
    setToasts((t) => [...t, { id, text, tone }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600)
  }, [])

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            {t.tone === 'ok' ? <IconCheck size={16} /> : <IconAlert size={16} />}
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export const useToast = () => useContext(ToastContext)

// ── Clipboard ─────────────────────────────────────────────────────────────

/** How long a copied secret stays on the clipboard. Clearing is best effort:
 *  it only works while this tab is focused, and only if the clipboard still
 *  holds what was put there. */
const CLIPBOARD_CLEAR_MS = 30_000
let clearTimer: ReturnType<typeof setTimeout> | null = null

async function copySecret(value: string): Promise<void> {
  await navigator.clipboard.writeText(value)
  if (clearTimer) clearTimeout(clearTimer)
  clearTimer = setTimeout(async () => {
    try {
      if ((await navigator.clipboard.readText()) === value) await navigator.clipboard.writeText('')
    } catch {
      // Reading the clipboard needs focus and permission; without them the
      // value stays, which is no worse than not trying.
    }
  }, CLIPBOARD_CLEAR_MS)
}

export function CopyButton({ value, label }: { value: string | undefined; label: string }) {
  const toast = useToast()
  const [done, setDone] = useState(false)
  if (!value) return null
  return (
    <button type="button" className="icon-btn" title={`Copy ${label.toLowerCase()}`}
            aria-label={`Copy ${label.toLowerCase()}`}
            onClick={async () => {
              try {
                await copySecret(value)
                setDone(true)
                setTimeout(() => setDone(false), 1200)
                toast(`${label} copied — clears in 30 seconds`)
              } catch {
                toast('The browser refused clipboard access', 'error')
              }
            }}>
      {done ? <IconCheck size={16} /> : <IconCopy size={16} />}
    </button>
  )
}

// ── Password input with reveal ────────────────────────────────────────────

export function PasswordInput(props: {
  id: string
  value: string
  onChange: (v: string) => void
  autoComplete: string
  required?: boolean
  autoFocus?: boolean
  placeholder?: string
}) {
  const [shown, setShown] = useState(false)
  return (
    <div className="input-wrap">
      <input id={props.id} type={shown ? 'text' : 'password'} autoComplete={props.autoComplete}
             required={props.required} autoFocus={props.autoFocus} placeholder={props.placeholder}
             spellCheck={false} className="mono-when-shown"
             value={props.value} onChange={(e) => props.onChange(e.target.value)} />
      <button type="button" className="input-affix" onClick={() => setShown(!shown)}
              aria-label={shown ? 'Hide password' : 'Show password'} title={shown ? 'Hide' : 'Show'}>
        {shown ? <IconEyeOff size={16} /> : <IconEye size={16} />}
      </button>
    </div>
  )
}

// ── Strength ──────────────────────────────────────────────────────────────

/** A rough entropy estimate from length and character classes. It does not
 *  know about dictionary words, so it errs generous; it is a nudge, not a
 *  guarantee. */
export function strength(password: string): { score: 0 | 1 | 2 | 3 | 4; label: string } {
  if (!password) return { score: 0, label: '' }
  let pool = 0
  if (/[a-z]/.test(password)) pool += 26
  if (/[A-Z]/.test(password)) pool += 26
  if (/[0-9]/.test(password)) pool += 10
  if (/[^a-zA-Z0-9]/.test(password)) pool += 33
  const unique = new Set(password).size
  const bits = Math.log2(Math.max(pool, 2)) * Math.min(password.length, unique * 2)
  if (bits < 40) return { score: 1, label: 'Weak' }
  if (bits < 60) return { score: 2, label: 'Fair' }
  if (bits < 80) return { score: 3, label: 'Strong' }
  return { score: 4, label: 'Excellent' }
}

export function StrengthMeter({ password }: { password: string }) {
  const { score, label } = strength(password)
  return (
    <div className={`strength s-${score}`} aria-live="polite">
      <div className="strength-bars"><span /><span /><span /><span /></div>
      <span className="strength-label">{label || ' '}</span>
    </div>
  )
}

// ── Generator ─────────────────────────────────────────────────────────────

const SETS = {
  lower: 'abcdefghijkmnopqrstuvwxyz',
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  digits: '23456789',
  symbols: '!@#$%^&*()-_=+[]{};:,.?',
}

/** Uniform over the alphabet: bytes above the largest multiple of its length
 *  are rejected rather than folded, which would bias the low characters. */
export function generatePassword(length: number, opts: { upper: boolean; digits: boolean; symbols: boolean }): string {
  const alphabet = SETS.lower + (opts.upper ? SETS.upper : '') + (opts.digits ? SETS.digits : '') + (opts.symbols ? SETS.symbols : '')
  const limit = 256 - (256 % alphabet.length)
  let out = ''
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (b < limit && out.length < length) out += alphabet[b % alphabet.length]
    }
  }
  return out
}

export function Generator({ onUse }: { onUse: (password: string) => void }) {
  const [length, setLength] = useState(20)
  const [upper, setUpper] = useState(true)
  const [digits, setDigits] = useState(true)
  const [symbols, setSymbols] = useState(true)
  const [value, setValue] = useState('')

  const regenerate = useCallback(() => setValue(generatePassword(length, { upper, digits, symbols })),
    [length, upper, digits, symbols])
  useEffect(regenerate, [regenerate])

  return (
    <div className="generator">
      <div className="generator-out">
        <code>{value}</code>
        <button type="button" className="icon-btn" onClick={regenerate} title="Regenerate" aria-label="Regenerate">
          <IconRefresh size={16} />
        </button>
      </div>
      <div className="generator-opts">
        <label className="range">
          <span>Length <strong>{length}</strong></span>
          <input type="range" min={8} max={64} value={length} onChange={(e) => setLength(Number(e.target.value))} />
        </label>
        <Check checked={upper} onChange={setUpper}>A–Z</Check>
        <Check checked={digits} onChange={setDigits}>0–9</Check>
        <Check checked={symbols} onChange={setSymbols}>!@#</Check>
      </div>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => onUse(value)}>Use this password</button>
    </div>
  )
}

export function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  )
}

// ── Entry types ───────────────────────────────────────────────────────────

export const TYPES: { type: EntryType; label: string; plural: string; Icon: (p: { size?: number }) => JSX.Element }[] = [
  { type: 'login', label: 'Login', plural: 'Logins', Icon: IconKey },
  { type: 'note', label: 'Secure note', plural: 'Secure notes', Icon: IconNote },
  { type: 'card', label: 'Card', plural: 'Cards', Icon: IconCard },
  { type: 'identity', label: 'Identity', plural: 'Identities', Icon: IconUser },
  { type: 'bankAccount', label: 'Bank account', plural: 'Bank accounts', Icon: IconBank },
  { type: 'sshKey', label: 'SSH key', plural: 'SSH keys', Icon: IconTerminal },
  { type: 'wifi', label: 'Wi-Fi', plural: 'Wi-Fi', Icon: IconWifi },
]

export const typeInfo = (t: EntryType) => TYPES.find((x) => x.type === t) ?? TYPES[0]!

/** A coloured initial in place of a site favicon, which would have to be
 *  fetched from somewhere and would say which sites the vault holds. */
export function Monogram({ name, size = 'md' }: { name: string; size?: 'md' | 'lg' }) {
  const letter = (name.trim()[0] ?? '?').toUpperCase()
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return <span className={`monogram monogram-${size} av-${h % 8}`} aria-hidden="true">{letter}</span>
}
