// Which saved logins belong to a page (decisions/0029).
//
// The browser extension fills only what matches here, so this is the line
// between a login form and a phishing page:
//
//   origin  scheme, host and port all equal: the strongest match.
//   domain  the page is https and both hosts share a registrable domain
//           (eTLD+1 under the Public Suffix List): accounts.example.com and
//           www.example.com, but never example.com.evil.io or a user's
//           neighbour on github.io.
//
// IP addresses and single-label hosts (localhost) match by origin only, and
// a page served over http never gets an https item.

import { PSL_RULES } from './psl-data.js'

let rules: Set<string> | null = null
const ruleSet = (): Set<string> => (rules ??= new Set(PSL_RULES.split('\n')))

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

function isAddressOrLocal(host: string): boolean {
  return IPV4.test(host) || host.includes(':') || host.startsWith('[') || !host.includes('.')
}

/** The registrable domain (eTLD+1) of a host, or null for an IP address, a
 *  single-label host, or a host that is itself a public suffix. */
export function registrableDomain(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (!host || isAddressOrLocal(host)) return null
  const labels = host.split('.')
  if (labels.some((l) => l === '')) return null
  const set = ruleSet()
  // The prevailing rule is the one with the most labels; an exception rule
  // wins outright. With no rule, the default "*" makes the last label the suffix.
  let suffix = 1
  for (let i = 0; i < labels.length; i++) {
    const candidate = labels.slice(i).join('.')
    if (set.has(`!${candidate}`)) { suffix = labels.length - i - 1; break }
    const parent = labels.slice(i + 1).join('.')
    if (set.has(candidate) || (parent && set.has(`*.${parent}`))) { suffix = Math.max(suffix, labels.length - i); break }
  }
  if (labels.length <= suffix) return null
  return labels.slice(labels.length - suffix - 1).join('.')
}

function parse(url: string | undefined): URL | null {
  if (!url) return null
  const text = url.trim()
  if (!text) return null
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null
  } catch { return null }
}

export type SiteMatch = 'origin' | 'domain'

/** How an item's saved URL matches a page, or null when it must not fill. */
export function matchSite(itemUrl: string | undefined, pageUrl: string): SiteMatch | null {
  const item = parse(itemUrl), page = parse(pageUrl)
  if (!item || !page || !item.hostname || !page.hostname) return null
  if (item.origin === page.origin) return 'origin'
  // An https item never goes to an http page; an http item may go to the
  // same site over https, which only upgrades the connection.
  if (page.protocol !== 'https:') return null
  const a = registrableDomain(item.hostname), b = registrableDomain(page.hostname)
  return a !== null && a === b ? 'domain' : null
}

/** The items that match a page, best first: origin matches, then domain
 *  matches, each by most recent use. */
export function rankForPage<T>(items: readonly T[], pageUrl: string, urlOf: (item: T) => string | undefined, usedAt: (item: T) => number = () => 0): T[] {
  return items
    .map((item) => ({ item, match: matchSite(urlOf(item), pageUrl) }))
    .filter((x): x is { item: T; match: SiteMatch } => x.match !== null)
    .sort((x, y) => (x.match === y.match ? usedAt(y.item) - usedAt(x.item) : x.match === 'origin' ? -1 : 1))
    .map((x) => x.item)
}
