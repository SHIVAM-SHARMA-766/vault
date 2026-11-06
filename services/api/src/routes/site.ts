// The admin panel's website editor: draft, preview, publish, roll back, and
// images. Permissions are checked by the router (site.read, site.write,
// site.publish); see roles.ts.

import { randomBytes } from 'node:crypto'

import { referencedMedia } from '@vault/site/content'

import type { App } from '../context.js'
import { type LambdaEvent, type LambdaResponse, HttpError, badRequest, conflict, json, notFound, parseJsonBody, tooLarge } from '../http.js'
import { SYSTEM_PK } from '../keys.js'
import { audit } from '../system.js'
import {
  DRAFT_SK,
  LIVE_SK,
  MAX_MEDIA_BYTES,
  type SiteConfig,
  VERSION_PREFIX,
  check,
  listMediaMeta,
  liveContent,
  loadSource,
  mediaMetaSk,
  mediaSk,
  pruneVersions,
  publishToDisk,
  renderToStrings,
  sniffImage,
  syncMedia,
  versionSk,
} from '../site.js'

function siteConfig(app: App): SiteConfig {
  if (!app.site) throw new HttpError(503, 'unavailable', 'Website editing is not configured on this server.')
  return app.site
}

function invalid(errors: { path: string; message: string }[]): HttpError {
  const err = new HttpError(400, 'invalid_content', `${errors.length} field(s) need attention.`)
  err.details = errors
  return err
}

export async function getSite(app: App): Promise<LambdaResponse> {
  const cfg = siteConfig(app)
  const src = await loadSource(cfg.sourceDir)
  const [draft, live, versions, media] = await Promise.all([
    app.store.get(SYSTEM_PK, DRAFT_SK),
    liveContent(app, cfg),
    app.store.query(SYSTEM_PK, VERSION_PREFIX),
    listMediaMeta(app),
  ])
  const liveRow = live.version ? versions.find((v) => v.sk === versionSk(live.version!)) : undefined
  return json(200, {
    schema: src.schema,
    defaults: src.defaults,
    live: {
      version: live.version,
      content: live.content,
      publishedAt: liveRow?.['publishedAt'] ?? null,
      publishedBy: liveRow?.['publishedBy'] ?? null,
    },
    draft: draft
      ? { content: draft['content'], updatedAt: draft['updatedAt'] ?? null, updatedBy: draft['updatedBy'] ?? null }
      : null,
    versions: versions
      .map((v) => ({
        version: v.sk.slice(VERSION_PREFIX.length),
        publishedAt: v['publishedAt'] ?? null,
        publishedBy: v['publishedBy'] ?? null,
        note: v['note'] ?? null,
      }))
      .sort((a, b) => b.version.localeCompare(a.version)),
    media,
  })
}

export async function saveDraft(app: App, actor: string, event: LambdaEvent): Promise<LambdaResponse> {
  const cfg = siteConfig(app)
  const body = parseJsonBody<{ content?: unknown }>(event)
  const { content, errors } = await check(app, cfg, body.content)
  if (errors.length) throw invalid(errors)
  await app.store.put({
    pk: SYSTEM_PK, sk: DRAFT_SK, content,
    updatedAt: new Date(app.now()).toISOString(), updatedBy: actor,
  })
  return json(200, { ok: true, content })
}

export async function discardDraft(app: App, actor: string): Promise<LambdaResponse> {
  siteConfig(app)
  await audit(app, actor, 'site.discard-draft')
  await app.store.delete(SYSTEM_PK, DRAFT_SK)
  return json(200, { ok: true })
}

/** Publishes the saved draft. The draft is validated again here: the schema
 *  or the image library may have changed since it was saved. */
export async function publish(app: App, actor: string, event: LambdaEvent): Promise<LambdaResponse> {
  const cfg = siteConfig(app)
  const body = parseJsonBody<{ note?: unknown }>(event)
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 140) : ''
  const draft = await app.store.get(SYSTEM_PK, DRAFT_SK)
  if (!draft) throw badRequest('There is no draft to publish.')
  const { content, errors } = await check(app, cfg, draft['content'])
  if (errors.length) throw invalid(errors)

  const now = new Date(app.now())
  // Sortable and unique enough for one operator: the timestamp plus a nonce.
  const version = `${now.toISOString().replace(/[-:.]/g, '')}-${randomBytes(2).toString('hex')}`
  await audit(app, actor, 'site.publish', version, note || undefined)
  await app.store.put({
    pk: SYSTEM_PK, sk: versionSk(version), content,
    publishedAt: now.toISOString(), publishedBy: actor, ...(note ? { note } : {}),
  })
  await app.store.put({ pk: SYSTEM_PK, sk: LIVE_SK, version })
  await app.store.delete(SYSTEM_PK, DRAFT_SK)
  await pruneVersions(app)
  await publishToDisk(app, cfg)
  return json(200, { ok: true, version })
}

export async function rollback(app: App, actor: string, version: string): Promise<LambdaResponse> {
  const cfg = siteConfig(app)
  if (!/^[0-9TZ]{15,20}-[0-9a-f]{4}$/.test(version)) throw badRequest('Invalid version.')
  const row = await app.store.get(SYSTEM_PK, versionSk(version))
  if (!row) throw notFound()
  // A version can refer to an image deleted since; check before making it live.
  const { errors } = await check(app, cfg, row['content'])
  if (errors.length) throw invalid(errors)
  await audit(app, actor, 'site.rollback', version)
  await app.store.put({ pk: SYSTEM_PK, sk: LIVE_SK, version })
  await publishToDisk(app, cfg)
  return json(200, { ok: true, version })
}

/** Renders one page of the given content without saving or publishing it.
 *  The panel opens the result from a blob, so URLs are made absolute. */
export async function preview(app: App, event: LambdaEvent): Promise<LambdaResponse> {
  const cfg = siteConfig(app)
  const body = parseJsonBody<{ content?: unknown; page?: unknown }>(event)
  const page = typeof body.page === 'string' ? body.page : 'index.html'
  const { content, errors } = await check(app, cfg, body.content)
  if (errors.length) throw invalid(errors)
  const pages = await renderToStrings(app, cfg, content, cfg.origin)
  const html = pages[page]
  if (!html) throw notFound()
  return json(200, { html })
}

export async function uploadMedia(app: App, actor: string, event: LambdaEvent): Promise<LambdaResponse> {
  const cfg = siteConfig(app)
  const body = parseJsonBody<{ name?: unknown; data?: unknown }>(event)
  if (typeof body.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.data)) throw badRequest('data must be base64.')
  const bytes = Buffer.from(body.data, 'base64')
  if (bytes.length > MAX_MEDIA_BYTES) throw tooLarge('Images are limited to 2 MB.')
  const type = sniffImage(bytes)
  if (!type) throw badRequest('Only PNG, JPEG and WebP images are accepted.')
  const name = (typeof body.name === 'string' ? body.name : 'image').replace(/[^\w .()-]/g, '').trim().slice(0, 100) || 'image'

  const id = `m_${randomBytes(12).toString('base64url')}`
  const meta = { id, type, name, bytes: bytes.length, uploadedAt: new Date(app.now()).toISOString(), uploadedBy: actor }
  await audit(app, actor, 'media.upload', id, name)
  await app.store.put({ pk: SYSTEM_PK, sk: mediaSk(id), data: body.data })
  await app.store.put({ pk: SYSTEM_PK, sk: mediaMetaSk(id), ...meta })
  // On disk at once, so a preview that uses it can show it.
  await syncMedia(app, cfg)
  return json(201, { media: meta })
}

export async function deleteMedia(app: App, actor: string, id: string): Promise<LambdaResponse> {
  const cfg = siteConfig(app)
  if (!/^m_[A-Za-z0-9_-]{16,}$/.test(id)) throw badRequest('Invalid image id.')
  const [draft, live] = await Promise.all([app.store.get(SYSTEM_PK, DRAFT_SK), liveContent(app, cfg)])
  const inUse = referencedMedia(live.content)
  for (const ref of referencedMedia(draft?.['content'])) inUse.add(ref)
  if (inUse.has(id)) throw conflict('That image is used by the live site or the draft. Replace it there first.')
  await audit(app, actor, 'media.delete', id)
  await app.store.delete(SYSTEM_PK, mediaMetaSk(id))
  await app.store.delete(SYSTEM_PK, mediaSk(id))
  await syncMedia(app, cfg)
  return json(200, { ok: true })
}
