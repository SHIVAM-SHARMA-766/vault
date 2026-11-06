// The public website, as content the admin panel edits and the API publishes.
//
// Content lives in the SYSTEM partition: one draft, a history of published
// versions, a pointer to the live one, and uploaded images. Publishing renders
// the templates that shipped with this release (api/site/ on the host) with
// the live content into a fresh directory, then swaps a symlink, so a reader
// never sees a half-written site. Caddy serves /srv/vault/site/current.
//
// The renderer escapes every value and allows no markup from content; see
// apps/site/lib/render.mjs for why that matters on this origin.
//
// See decisions/0007-roles-and-site-editing.md.

import { randomBytes } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { imageFallbacks, validateContent } from '@vault/site/content'
import { MEDIA_TYPES, renderPages } from '@vault/site/render'

import type { App } from './context.js'
import { SYSTEM_PK } from './keys.js'
import type { Item } from './store.js'

export interface SiteConfig {
  /** Holds templates/, static/ and content/ from apps/site. */
  sourceDir: string
  /** Where rendered versions are written; Caddy serves <outputDir>/current. */
  outputDir: string
  /** https origin of the site, for share-image URLs and previews. */
  origin: string
}

export const DRAFT_SK = 'SITE#DRAFT'
export const LIVE_SK = 'SITE#LIVE'
export const VERSION_PREFIX = 'SITE#V#'
export const MEDIA_META_PREFIX = 'MEDIAMETA#'
export const versionSk = (v: string) => `${VERSION_PREFIX}${v}`
export const mediaSk = (id: string) => `MEDIA#${id}`
export const mediaMetaSk = (id: string) => `${MEDIA_META_PREFIX}${id}`

/** History kept in the table. Older versions are removed on publish. */
const KEEP_VERSIONS = 30
/** Rendered versions kept on disk, for an instant manual swap if needed. */
const KEEP_RENDERS = 3
export const MAX_MEDIA_BYTES = 2 * 1024 * 1024

export interface MediaMetaFields {
  id: string
  type: string
  name: string
  bytes: number
  uploadedAt: string
  uploadedBy: string
}

interface Source {
  schema: unknown
  defaults: unknown
  pages: Record<string, string>
  partials: Record<string, string>
}

const sources = new Map<string, Source>()

/** Templates and schema are part of the release, so they are read once per
 *  process: a new release restarts the API. */
export async function loadSource(dir: string): Promise<Source> {
  const cached = sources.get(dir)
  if (cached) return cached
  const readDir = async (sub: string) => {
    const names = (await readdir(join(dir, sub))).filter((f) => f.endsWith('.html'))
    return Object.fromEntries(await Promise.all(names.map(async (n) => [n, await readFile(join(dir, sub, n), 'utf8')] as const)))
  }
  const rawPages = await readDir('templates')
  const rawPartials = await readDir('templates/partials')
  const source: Source = {
    schema: JSON.parse(await readFile(join(dir, 'content/schema.json'), 'utf8')),
    defaults: JSON.parse(await readFile(join(dir, 'content/defaults.json'), 'utf8')),
    pages: rawPages,
    partials: Object.fromEntries(Object.entries(rawPartials).map(([k, v]) => [k.replace(/\.html$/, ''), v])),
  }
  sources.set(dir, source)
  return source
}

export async function listMediaMeta(app: App): Promise<MediaMetaFields[]> {
  const rows = await app.store.query(SYSTEM_PK, MEDIA_META_PREFIX)
  return rows.map((r) => ({
    id: String(r['id']), type: String(r['type']), name: String(r['name'] ?? ''),
    bytes: Number(r['bytes'] ?? 0), uploadedAt: String(r['uploadedAt'] ?? ''), uploadedBy: String(r['uploadedBy'] ?? ''),
  }))
}

export async function check(app: App, cfg: SiteConfig, input: unknown) {
  const src = await loadSource(cfg.sourceDir)
  const media = await listMediaMeta(app)
  return validateContent(src.schema, input, src.defaults, new Set(media.map((m) => m.id)))
}

/** The content that is live: the published version, or the defaults. */
export async function liveContent(app: App, cfg: SiteConfig): Promise<{ version: string | null; content: unknown }> {
  const live = await app.store.get(SYSTEM_PK, LIVE_SK)
  const version = typeof live?.['version'] === 'string' ? live['version'] : null
  const row = version ? await app.store.get(SYSTEM_PK, versionSk(version)) : null
  const { content } = await check(app, cfg, row?.['content'] ?? {})
  return { version: row ? version : null, content }
}

export async function renderToStrings(app: App, cfg: SiteConfig, content: unknown, base = '') {
  const src = await loadSource(cfg.sourceDir)
  const media = await listMediaMeta(app)
  return renderPages({
    pages: src.pages, partials: src.partials, content, media,
    fallbacks: imageFallbacks(src.schema), base, origin: cfg.origin,
  })
}

/** Renders the live content to disk and makes it current. Safe to call at any
 *  time; a failure leaves the previous render serving. */
export async function publishToDisk(app: App, cfg: SiteConfig): Promise<string> {
  const { content } = await liveContent(app, cfg)
  const pages = await renderToStrings(app, cfg, content)

  const name = `v-${Date.now()}-${randomBytes(3).toString('hex')}`
  const dir = join(cfg.outputDir, name)
  await mkdir(dir, { recursive: true })
  await cp(join(cfg.sourceDir, 'static'), dir, { recursive: true })
  for (const [file, html] of Object.entries(pages)) await writeFile(join(dir, file), html)

  await syncMedia(app, cfg)

  // A symlink renamed over the old one is atomic: Caddy sees the old site or
  // the new one, never a mix.
  const tmp = join(cfg.outputDir, `.current-${name}`)
  await symlink(name, tmp)
  await rename(tmp, join(cfg.outputDir, 'current'))

  const old = (await readdir(cfg.outputDir)).filter((f) => f.startsWith('v-') && f !== name).sort().reverse()
  for (const f of old.slice(KEEP_RENDERS - 1)) await rm(join(cfg.outputDir, f), { recursive: true, force: true })
  return name
}

/** Writes every stored image to <outputDir>/media and removes files for
 *  images that no longer exist. Media is shared by all versions, so a
 *  rollback never points at a missing image that is still stored. */
export async function syncMedia(app: App, cfg: SiteConfig): Promise<void> {
  const dir = join(cfg.outputDir, 'media')
  await mkdir(dir, { recursive: true })
  const meta = await listMediaMeta(app)
  const wanted = new Map(meta.map((m) => [`${m.id}.${MEDIA_TYPES[m.type]}`, m]))
  const present = new Set(await readdir(dir))
  for (const [file, m] of wanted) {
    if (present.has(file)) continue
    const row = await app.store.get(SYSTEM_PK, mediaSk(m.id))
    if (typeof row?.['data'] === 'string') await writeFile(join(dir, file), Buffer.from(row['data'], 'base64'))
  }
  for (const file of present) if (!wanted.has(file)) await rm(join(dir, file), { force: true })
}

/** Accepts PNG, JPEG and WebP only, identified by their bytes rather than by
 *  the name or the declared type. SVG is refused: it can carry script, and on
 *  this origin that is not a risk worth an icon format. */
export function sniffImage(bytes: Buffer): string | null {
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length > 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

export async function pruneVersions(app: App): Promise<void> {
  const rows = await app.store.query(SYSTEM_PK, VERSION_PREFIX)
  const old = rows.sort((a, b) => b.sk.localeCompare(a.sk)).slice(KEEP_VERSIONS)
  for (const r of old) await app.store.delete(r.pk, r.sk)
}

export type VersionRow = Item & { content: unknown; publishedAt: string; publishedBy: string; note?: string }
