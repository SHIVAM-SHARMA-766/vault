// The vault's home (design refresh): what the right-hand pane shows when no
// item is open. A security score from the health check, the items opened
// lately and the favourites, and the getting-started steps while any are left.
// Everything here is computed in this browser from the decrypted vault.

import { useEffect, useState } from 'react'

import type { Decrypted } from './model.js'
import { GettingStarted } from './GettingStarted.js'
import { IconChevron, IconPlus, IconStar } from '../../ui/icons.js'
import { Monogram } from '../../ui/kit.js'

const RECENT_MAX = 6
const recentKey = (userId: string) => `vault.recent.${userId}`

/** Item ids opened lately, newest first (ids only: they say nothing). */
export function rememberOpened(userId: string, id: string): void {
  try {
    const list = [id, ...readRecent(userId).filter((x) => x !== id)].slice(0, 20)
    localStorage.setItem(recentKey(userId), JSON.stringify(list))
  } catch { /* storage blocked: no recents */ }
}
function readRecent(userId: string): string[] {
  try { const v = JSON.parse(localStorage.getItem(recentKey(userId)) ?? '[]') as unknown; return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [] } catch { return [] }
}

function greeting(): string {
  const h = new Date().getHours()
  return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}

export function VaultHome({ userId, entries, health, sharedCount, onOpen, onNew, onReview }: {
  userId: string
  entries: Decrypted[]
  health: { checked: number; failing: number }
  sharedCount: number
  onOpen: (id: string) => void
  onNew: () => void
  onReview: () => void
}) {
  const [recent, setRecent] = useState<string[]>([])
  useEffect(() => { setRecent(readRecent(userId)) }, [userId, entries.length])
  const byId = new Map(entries.map((e) => [e.id, e]))
  const lately = recent.map((id) => byId.get(id)).filter((e): e is Decrypted => !!e && !e.unreadable).slice(0, RECENT_MAX)
  const favorites = entries.filter((e) => e.favorite && !e.unreadable).slice(0, RECENT_MAX)
  const score = health.checked ? Math.round((100 * (health.checked - health.failing)) / health.checked) : null
  const grade = score === null ? null : score >= 90 ? 'Excellent' : score >= 75 ? 'Good' : score >= 50 ? 'Fair' : 'Needs work'
  const tone = score === null ? 'none' : score >= 90 ? 'ok' : score >= 75 ? 'good' : score >= 50 ? 'warn' : 'bad'
  const R = 34, C = 2 * Math.PI * R

  return (
    <div className="home">
      <header className="home-head">
        <div>
          <h2>{greeting()}</h2>
          <p className="muted">{entries.length ? `${entries.length} item${entries.length === 1 ? '' : 's'} in your vault, encrypted on this device.` : 'Your vault is empty. Add your first item to begin.'}</p>
        </div>
        {entries.length === 0 ? <button className="btn btn-primary" onClick={onNew}><IconPlus size={16} />Add your first item</button> : null}
      </header>

      <div className="home-grid">
        <section className={`home-card score-card score-${tone}`} aria-labelledby="score-title">
          <svg className="score-ring" viewBox="0 0 84 84" role="img" aria-label={score === null ? 'No passwords checked yet' : `Security score ${score} out of 100`}>
            <circle className="ring-track" cx="42" cy="42" r={R} />
            <circle className="ring-value" cx="42" cy="42" r={R} strokeDasharray={C} strokeDashoffset={score === null ? C : C * (1 - score / 100)} />
            <text x="42" y="47" textAnchor="middle" className="ring-text">{score ?? '–'}</text>
          </svg>
          <div className="score-text">
            <h3 id="score-title">Security score</h3>
            <p className="score-grade">{grade ?? 'Nothing to check yet'}</p>
            <p className="muted small">{score === null ? 'Passwords are checked as you add them.' : health.failing ? `${health.failing} of ${health.checked} passwords need attention.` : `All ${health.checked} passwords are strong, unique and recent.`}</p>
            {health.failing ? <button className="btn btn-secondary btn-sm" onClick={onReview}>Review issues</button> : null}
          </div>
        </section>

        <section className="home-card stat-tiles" aria-label="Your vault at a glance">
          <div><strong>{entries.length}</strong><span>Items</span></div>
          <div><strong>{entries.filter((e) => e.favorite).length}</strong><span>Favourites</span></div>
          <div><strong>{sharedCount}</strong><span>Shared with you</span></div>
        </section>
      </div>

      {lately.length ? <ItemStrip title="Opened lately" items={lately} onOpen={onOpen} /> : null}
      {favorites.length ? <ItemStrip title="Favourites" icon={<IconStar size={14} filled />} items={favorites} onOpen={onOpen} /> : null}

      <GettingStarted userId={userId} hasItems={entries.length > 0} onNew={onNew} compact />
    </div>
  )
}

function ItemStrip({ title, icon, items, onOpen }: { title: string; icon?: React.ReactNode; items: Decrypted[]; onOpen: (id: string) => void }) {
  return (
    <section className="home-strip" aria-label={title}>
      <h3>{icon}{title}</h3>
      <ul>
        {items.map((e) => (
          <li key={e.id}>
            <button className="tile" onClick={() => onOpen(e.id)}>
              <Monogram name={e.name} url={e.url} />
              <span className="tile-text"><span className="tile-name">{e.name || 'Untitled'}</span><span className="tile-meta">{e.username || hostOf(e.url) || ''}</span></span>
              <IconChevron size={14} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function hostOf(url: string | undefined): string {
  if (!url) return ''
  try { return new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, '') } catch { return '' }
}

