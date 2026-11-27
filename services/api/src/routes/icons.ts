// Website icons for items (design refresh): GET /api/icons/<host>.
//
// An item's website is encrypted, so the app asks for its icon by host name
// only, with no sign-in: the request carries no token, and the server cannot
// tie a host to an account. (It does see the network address that asks; the
// icon can be turned off in Preferences, and the threat model says so.)
//
// The fetch is the backups' guarded one (egress.ts): https only, public
// addresses only, the resolved address pinned, size-capped. Redirects are
// followed by hand, three at most, each hop checked again. Only raster images
// are passed on (PNG, ICO, JPEG, GIF, WebP), checked by their first bytes, never
// SVG, which can carry script. Answers, found or not, are kept for a week.

import type { App } from '../context.js'
import type { LambdaEvent, LambdaResponse } from '../http.js'
import { guardedRequest } from '../egress.js'
import { enforce } from '../ratelimit.js'

const PK = 'ICON'
const FOUND_SECONDS = 7 * 86_400
const MISSING_SECONDS = 86_400
const MAX_BYTES = 100_000
const HOST_RE = /^(?=.{3,253}$)(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/

/** The image type of some bytes, or null for anything else (SVG included). */
export function sniff(b: Buffer): string | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (b.length >= 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'image/x-icon'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 6 && (b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a')) return 'image/gif'
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}

/** A GET through the guard, following up to three redirects. */
async function get(url: string, maxBytes: number): Promise<{ status: number; type: string; body: Buffer; url: string } | null> {
  let current = url
  for (let hop = 0; hop < 4; hop++) {
    const res = await guardedRequest(current, {
      allowPrivate: false, timeoutMs: 4000, maxResponseBytes: maxBytes,
      headers: { 'user-agent': 'Vault-icon-fetcher/1 (+https://github.com/SHIVAM-SHARMA-766/vault)', accept: 'image/*,text/html;q=0.8' },
    }).catch(() => null)
    if (!res) return null
    if (res.status >= 300 && res.status < 400 && typeof res.headers.location === 'string') {
      try { current = new URL(res.headers.location, current).toString() } catch { return null }
      continue
    }
    return { status: res.status, type: String(res.headers['content-type'] ?? ''), body: res.body, url: current }
  }
  return null
}

/** The icon links a page declares, best first (apple-touch, then sized icons). */
export function iconLinks(html: string, base: string): string[] {
  const out: { href: string; score: number }[] = []
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0]
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? ''
    if (!/\bicon\b/.test(rel) && !/apple-touch-icon/.test(rel)) continue
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? /\bhref\s*=\s*([^\s>]+)/i.exec(tag)?.[1]
    if (!href || /\.svg(\?|$)/i.test(href) || /image\/svg/i.test(tag)) continue
    const size = Number(/\bsizes\s*=\s*["']?(\d+)x\d+/i.exec(tag)?.[1] ?? 0)
    let abs: string
    try { abs = new URL(href, base).toString() } catch { continue }
    if (!abs.startsWith('https://')) continue
    out.push({ href: abs, score: (rel.includes('apple-touch') ? 200 : 0) + Math.min(size, 192) })
  }
  return out.sort((a, b) => b.score - a.score).map((x) => x.href)
}

async function find(host: string): Promise<{ type: string; body: Buffer } | null> {
  const tried = new Set<string>()
  const attempt = async (url: string) => {
    if (tried.has(url) || tried.size >= 5) return null
    tried.add(url)
    const r = await get(url, MAX_BYTES)
    if (!r || r.status !== 200 || r.body.length < 16) return null
    const type = sniff(r.body)
    return type ? { type, body: r.body } : null
  }
  // What the home page declares, then the usual places.
  const page = await get(`https://${host}/`, 256_000)
  if (page && page.status === 200 && /text\/html/i.test(page.type)) {
    for (const href of iconLinks(page.body.toString('utf8'), page.url).slice(0, 3)) {
      const icon = await attempt(href)
      if (icon) return icon
    }
  }
  for (const path of ['/apple-touch-icon.png', '/favicon.ico']) {
    const icon = await attempt(`https://${host}${path}`)
    if (icon) return icon
  }
  return null
}

const image = (type: string, body: Buffer): LambdaResponse => ({
  statusCode: 200,
  headers: {
    'content-type': type, 'cache-control': 'public, max-age=604800, immutable', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'", 'cross-origin-resource-policy': 'same-origin',
  },
  body: body.toString('base64'),
  isBase64Encoded: true,
})

const none = (): LambdaResponse => ({ statusCode: 404, headers: { 'cache-control': 'public, max-age=86400', 'content-type': 'text/plain' }, body: '' })

export async function icon(app: App, event: LambdaEvent, raw: string): Promise<LambdaResponse> {
  const host = raw.toLowerCase().replace(/\.png$/, '').replace(/^www\./, '')
  if (!HOST_RE.test(host)) return none()
  const cached = await app.store.get(PK, host)
  const now = Math.floor(app.now() / 1000)
  if (cached && Number(cached['expiresAt']) > now) {
    return cached['missing'] ? none() : image(String(cached['type']), Buffer.from(String(cached['data']), 'base64'))
  }
  // Only fetches count against the limit; cached answers are free.
  await enforce(app.store, 'icon-ip', event.requestContext.http.sourceIp, { max: 120, windowSeconds: 15 * 60 }, app.now())
  const found = await find(host).catch(() => null)
  if (!found) {
    await app.store.put({ pk: PK, sk: host, missing: true, expiresAt: now + MISSING_SECONDS })
    return none()
  }
  await app.store.put({ pk: PK, sk: host, type: found.type, data: found.body.toString('base64'), expiresAt: now + FOUND_SECONDS })
  return image(found.type, found.body)
}
