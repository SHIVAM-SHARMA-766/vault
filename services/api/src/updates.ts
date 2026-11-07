// "Is there a newer Vault?" for the admin panel. The server asks the release
// feed (GitHub's latest-release API for the project, or UPDATE_CHECK_URL for
// a fork) at most every twelve hours, sends nothing about this install beyond
// what any HTTP request carries, and shows the answer to staff only.
// UPDATE_CHECK=false turns it off entirely: no request is ever made.

import type { App } from './context.js'

const TTL_MS = 12 * 60 * 60 * 1000

export interface UpdateStatus {
  enabled: boolean
  current: string
  latest: string | null
  newer: boolean
  url: string | null
  publishedAt: string | null
  notes: string | null
  checkedAt: string | null
  error: string | null
}

let cache: { at: number; status: UpdateStatus } | null = null

/** For tests. */
export function forgetUpdateCheck(): void { cache = null }

/** Compares two versions as major.minor.patch, ignoring a leading v and any
 *  pre-release suffix. Returns null when either is not a version (e.g. dev). */
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim())?.slice(1).map(Number)
  const x = parse(a), y = parse(b)
  if (!x || !y) return null
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1
  return 0
}

export async function updateStatus(app: App, { force = false } = {}): Promise<UpdateStatus> {
  const current = app.config.version
  const base: UpdateStatus = { enabled: app.config.updateCheck.enabled, current, latest: null, newer: false, url: null, publishedAt: null, notes: null, checkedAt: null, error: null }
  if (!base.enabled) return base
  if (!force && cache && app.now() - cache.at < TTL_MS) return cache.status

  let status: UpdateStatus
  try {
    const res = await fetch(app.config.updateCheck.url, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'vault-update-check' },
      redirect: 'follow', signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 404) {
      status = { ...base, checkedAt: new Date(app.now()).toISOString(), error: 'No release has been published yet.' }
    } else if (!res.ok) {
      throw new Error(`the release feed answered ${res.status}`)
    } else {
      const r = (await res.json()) as { tag_name?: unknown; html_url?: unknown; published_at?: unknown; body?: unknown }
      const latest = typeof r.tag_name === 'string' ? r.tag_name.slice(0, 40) : null
      const url = typeof r.html_url === 'string' && /^https:\/\//.test(r.html_url) ? r.html_url : null
      const cmp = latest ? compareVersions(current, latest) : null
      status = {
        ...base, latest, url,
        newer: cmp !== null && cmp < 0,
        publishedAt: typeof r.published_at === 'string' ? r.published_at : null,
        notes: typeof r.body === 'string' ? r.body.slice(0, 1500) : null,
        checkedAt: new Date(app.now()).toISOString(),
      }
    }
  } catch (err) {
    status = { ...base, checkedAt: new Date(app.now()).toISOString(), error: `Could not check: ${(err as Error).message}`.slice(0, 200) }
  }
  cache = { at: app.now(), status }
  return status
}
