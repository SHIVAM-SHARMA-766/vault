// The first thing a new account sees beside its empty list: the few steps
// that make a vault safe to rely on, each checked against the real state
// where the app can know it. It goes away when done, or when hidden.

import { useEffect, useState } from 'react'

import { api } from '../../lib/api.js'
import { Link, href } from '../../lib/router.js'
import * as session from '../../lib/session.js'
import { IconCheck, IconShield } from '../../ui/icons.js'

const key = (userId: string, what: string) => `vault.onboarding.${userId}.${what}`
const read = (k: string) => { try { return localStorage.getItem(k) === '1' } catch { return false } }
const write = (k: string) => { try { localStorage.setItem(k, '1') } catch { /* storage blocked: shown again next time */ } }

export function GettingStarted({ userId, hasItems, onNew, compact = false }: { userId: string; hasItems: boolean; onNew: () => void; compact?: boolean }) {
  const [twoFactor, setTwoFactor] = useState<boolean | null>(null)
  const [backups, setBackups] = useState<boolean | null>(null)
  const [recoverySaved, setRecoverySaved] = useState(false)
  const [hidden, setHidden] = useState(false)
  // The account id can arrive a moment after unlock; read its flags once it has.
  useEffect(() => {
    setRecoverySaved(read(key(userId, 'recovery')))
    setHidden(read(key(userId, 'hidden')))
  }, [userId])

  useEffect(() => {
    void (async () => {
      try {
        const t = await session.token()
        const [me, b] = await Promise.all([api.me(t), api.backups.get(t)])
        setTwoFactor(me.twoFactor.enabled)
        setBackups(b.schedule.frequency !== 'off' || b.runs.some((r) => r.ok))
      } catch { /* the steps stay unticked */ }
    })()
  }, [])

  const steps = [
    { done: hasItems, title: 'Add your first items', text: 'Save a login, or bring everything over from another password manager.',
      action: <><button className="link" onClick={onNew}>Add an item</button> · <Link to={href({ name: 'transfer' })} className="link">Import</Link></> },
    { done: twoFactor === true, title: 'Turn on two-factor sign-in', text: 'A code from your phone, so a stolen password alone gets nobody in.',
      action: <Link to={href({ name: 'settings', tab: 'security' })} className="link">Turn it on</Link> },
    { done: backups === true, title: 'Set up backups', text: 'Your own encrypted copies, on a schedule, here or in your own storage.',
      action: <Link to={href({ name: 'settings', tab: 'backups' })} className="link">Choose a schedule</Link> },
    { done: recoverySaved, title: 'Keep your recovery key safe', text: 'It is the only way back in if you forget your master password. Print it, or store it away from this device.',
      action: <><button className="link" onClick={() => { write(key(userId, 'recovery')); setRecoverySaved(true) }}>I have stored it</button> · <Link to={href({ name: 'settings' })} className="link">Issue a new one</Link></> },
  ]
  const left = steps.filter((s) => !s.done).length
  if (hidden || left === 0) {
    return compact ? null : <div className="pane-empty"><IconShield size={40} /><p>Select an item to see its details</p></div>
  }

  return (
    <section className={`getting-started ${compact ? 'gs-compact home-card' : ''}`} aria-labelledby="gs-title">
      <h2 id="gs-title">Get started</h2>
      <p className="muted">{left} of {steps.length} steps left to make this vault safe to rely on.</p>
      <ol>
        {steps.map((s) => (
          <li key={s.title} className={s.done ? 'gs-done' : ''}>
            <span className="gs-mark" aria-hidden="true">{s.done ? <IconCheck size={14} /> : null}</span>
            <div>
              <h3>{s.title}{s.done ? <span className="visually-hidden"> (done)</span> : null}</h3>
              <p className="muted small">{s.text}</p>
              {s.done ? null : <p className="small">{s.action}</p>}
            </div>
          </li>
        ))}
      </ol>
      <button className="link small" onClick={() => { write(key(userId, 'hidden')); setHidden(true) }}>Hide this</button>
    </section>
  )
}
