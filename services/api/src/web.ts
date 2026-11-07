// Serving the client, the website and media from the API process itself.
//
// The reference instance puts Caddy in front and Caddy serves these files
// (apps/web/Caddyfile). A self-hosted install should not need that: one
// process, one port, behind whatever TLS proxy the customer already has — or
// the bundled Caddy of the install profiles. With SERVE_STATIC=true the server
// answers every path the Caddyfile does, the same way:
//
//   /api/*           the API (handled before this module is asked)
//   /app/*           the client; client-side routes get the shell, a missing
//                    asset stays a 404 rather than becoming HTML with a 200
//   /media/m_*.ext   images uploaded in the admin panel (png, jpg, webp only)
//   everything else  the rendered website, /x answering for x.html
//
// The security headers are the Caddyfile's, word for word; test/web.test.ts
// fails if the two ever differ. The shell is never cached and hashed assets
// are cached for a year — a cached shell after an upgrade points at assets
// that no longer exist, and the page is blank.

import { createReadStream, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'
import { createGzip } from 'node:zlib'

export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; upgrade-insecure-requests"

/** Every security header the Caddyfile sets. */
export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CSP,
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
}

/** Over plain http (local development only — browsers refuse WebCrypto on
 *  an insecure origin other than localhost), HSTS and the upgrade directive
 *  would point the browser at an https that does not exist. */
export function headersFor(origin: string): Record<string, string> {
  if (origin.startsWith('https://')) return SECURITY_HEADERS
  const { 'Strict-Transport-Security': _h, ...rest } = SECURITY_HEADERS
  return { ...rest, 'Content-Security-Policy': CSP.replace(/; upgrade-insecure-requests$/, '') }
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.json': 'application/json', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
}
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json', '.map', '.txt', '.webmanifest'])

export interface StaticRoots {
  /** The built client (apps/web/dist). */
  web: string
  /** Where the API renders the website; its current/ is served. */
  site: string
  origin: string
}

const isFile = (p: string) => { try { return statSync(p).isFile() } catch { return false } }

/** A path under root, or null if the request tries to leave it. */
function inside(root: string, rel: string): string | null {
  const full = normalize(join(root, rel))
  return full === root || full.startsWith(root.endsWith(sep) ? root : root + sep) ? full : null
}

function send(req: IncomingMessage, res: ServerResponse, status: number, file: string, roots: StaticRoots, cache: string): void {
  const ext = extname(file).toLowerCase()
  const headers: Record<string, string> = {
    ...headersFor(roots.origin),
    'Content-Type': TYPES[ext] ?? 'application/octet-stream',
    'Cache-Control': cache,
  }
  const gzip = COMPRESSIBLE.has(ext) && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))
  if (gzip) { headers['Content-Encoding'] = 'gzip'; headers['Vary'] = 'Accept-Encoding' }
  res.writeHead(status, headers)
  if (req.method === 'HEAD') { res.end(); return }
  const stream = createReadStream(file)
  stream.on('error', () => res.destroy())
  ;(gzip ? stream.pipe(createGzip()) : stream).pipe(res)
}

/** Serves a non-API request. Always answers. */
export function serveStatic(req: IncomingMessage, res: ServerResponse, roots: StaticRoots): void {
  let path: string
  try { path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname) } catch { res.writeHead(400); res.end(); return }
  const site = join(roots.site, 'current')
  const notFound = () => {
    const page = join(site, '404.html')
    if (isFile(page)) send(req, res, 404, page, roots, 'no-store')
    else { res.writeHead(404, headersFor(roots.origin)); res.end() }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { ...headersFor(roots.origin), Allow: 'GET, HEAD' }); res.end(); return }

  if (path === '/app') { res.writeHead(308, { ...headersFor(roots.origin), Location: '/app/' }); res.end(); return }
  if (path.startsWith('/app/')) {
    const rel = path.slice('/app/'.length) || 'index.html'
    const file = inside(roots.web, rel)
    const immutable = path.startsWith('/app/assets/')
    if (file && isFile(file)) return send(req, res, 200, file, roots, immutable ? 'public, max-age=31536000, immutable' : 'no-store')
    if (!/\.[a-zA-Z0-9]+$/.test(path)) return send(req, res, 200, join(roots.web, 'index.html'), roots, 'no-store')
    return notFound()
  }

  if (path.startsWith('/media/')) {
    const file = /^\/media\/m_[A-Za-z0-9_-]+\.(png|jpg|webp)$/.test(path) ? inside(roots.site, path) : null
    return file && isFile(file) ? send(req, res, 200, file, roots, 'no-store') : notFound()
  }

  for (const candidate of path.endsWith('/') ? [`${path}index.html`] : [path, `${path}.html`, `${path}/index.html`]) {
    const file = inside(site, candidate)
    if (file && isFile(file)) return send(req, res, 200, file, roots, 'no-store')
  }
  notFound()
}
