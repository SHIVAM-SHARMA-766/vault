// Renders the public site from templates and content.
//
// Used in two places with the same code: at build time with the default
// content (apps/site/scripts/build.mjs), and on the host by the API when
// someone publishes from the admin panel (services/api/src/site.ts).
//
// The site shares an origin with the vault client, so anything an editor types
// could reach the page that handles master passwords. The rules that keep it
// from doing so live here:
//
//   - every value is HTML-escaped; there is no way to emit raw markup from content
//   - links must be site-relative paths or https URLs
//   - icons come from a fixed set drawn in this file
//   - images are media ids resolved to /media/<id>.<ext>, or a fixed fallback
//
// Template syntax, deliberately small:
//
//   {{path.to.value}}           escaped text
//   {{paras path}}              one <p> per blank-line-separated paragraph
//   {{img path}}                URL of an image field (media or fallback)
//   {{absimg path}}             the same, as a full URL for share images
//   {{href path}}               a checked link
//   {{icon path}}               an icon from the fixed set
//   {{#each path}}…{{/each}}    repeat; inside, {{.field}} is relative to the item
//   {{#if path}}…{{/if}}        include when truthy (non-empty for strings/lists)
//   <!-- include:name -->       a partial, at the start of a line
//   <!-- page:id -->            which nav link is current
//   {{current:id}}              aria-current on the matching nav link

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c])

const ICON_PATHS = {
  shield: '<path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6l-8-3Z"/><path d="m9 12 2 2 4-4"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  note: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  refresh: '<path d="M20 11A8 8 0 0 0 6.3 6.3L4 8.5M4 13a8 8 0 0 0 13.7 4.7L20 15.5"/><path d="M4 4v4.5h4.5M20 20v-4.5h-4.5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  eye: '<path d="M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M3 3l18 18"/>',
  scale: '<path d="M12 3v18M5 7h14M5 7l-3 6a3 3 0 0 0 6 0L5 7Zm14 0-3 6a3 3 0 0 0 6 0l-3-6Z"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9L12 3Z"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8L3 12Z"/><circle cx="7.5" cy="8.5" r="1.5"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  cloud: '<path d="M7 18a5 5 0 1 1 .9-9.9A6 6 0 0 1 19.5 10 4 4 0 0 1 18 18H7Z"/>',
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M14 9l2 2"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
}
export const ICONS = Object.keys(ICON_PATHS)
export const icon = (name, sw = '1.9') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] ?? ICON_PATHS.shield}</svg>`

/** A link an editor may set: a path on this site, an in-page anchor, or https.
 *  Anything else — javascript:, data:, protocol-relative, http — becomes '#'. */
export function safeHref(value) {
  const v = String(value ?? '').trim()
  if (/^\/(?!\/)[A-Za-z0-9\-._~/#?=&%]*$/.test(v)) return v
  if (/^#[A-Za-z0-9\-_]+$/.test(v)) return v
  if (/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(\/[A-Za-z0-9\-._~/#?=&%+]*)?$/.test(v)) return v
  return '#'
}

export const MEDIA_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }
export const mediaPath = (m) => `/media/${m.id}.${MEDIA_TYPES[m.type]}`

function lookup(scope, root, path) {
  if (path.startsWith('.')) return path.slice(1).split('.').reduce((o, k) => (o == null ? undefined : o[k]), scope)
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), root)
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'string') return v.trim().length > 0
  return Boolean(v)
}

/** Expands {{#each}} and {{#if}} blocks, innermost first, then the inline
 *  tags. Blocks of the same kind may nest; the regexes match the innermost. */
function expand(tpl, scope, ctx) {
  let out = tpl
  const eachRe = /\{\{#each ([\w.]+)\}\}((?:(?!\{\{#each )[\s\S])*?)\{\{\/each\}\}/
  const ifRe = /\{\{#if ([\w.]+)\}\}((?:(?!\{\{#if )[\s\S])*?)\{\{\/if\}\}/
  for (;;) {
    const m = out.match(eachRe)
    if (!m) break
    const list = lookup(scope, ctx.content, m[1])
    const body = m[2]
    const rendered = Array.isArray(list) ? list.map((item) => expand(body, item, ctx)).join('') : ''
    out = out.slice(0, m.index) + rendered + out.slice(m.index + m[0].length)
  }
  for (;;) {
    const m = out.match(ifRe)
    if (!m) break
    const v = lookup(scope, ctx.content, m[1])
    out = out.slice(0, m.index) + (truthy(v) ? expand(m[2], scope, ctx) : '') + out.slice(m.index + m[0].length)
  }
  return out.replace(/\{\{(paras|img|absimg|href|icon) ([\w.]+)\}\}|\{\{([\w.]+)\}\}/g, (_, helper, hpath, path) => {
    if (!helper) return escapeHtml(lookup(scope, ctx.content, path))
    const v = lookup(scope, ctx.content, hpath)
    switch (helper) {
      case 'paras':
        return String(v ?? '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
          .map((p) => `<p>${escapeHtml(p)}</p>`).join('\n')
      case 'img': {
        const media = typeof v === 'string' ? ctx.media.get(v) : undefined
        return escapeHtml(ctx.base + (media ? mediaPath(media) : ctx.fallbacks.get(hpath.replace(/^\./, '')) ?? '/img/vault.png'))
      }
      case 'absimg': {
        // Share images are read by other sites' crawlers, which need a full URL.
        const media = typeof v === 'string' ? ctx.media.get(v) : undefined
        return escapeHtml(ctx.origin + (media ? mediaPath(media) : ctx.fallbacks.get(hpath) ?? '/img/vault.png'))
      }
      case 'href': {
        const h = safeHref(v)
        return escapeHtml(h.startsWith('/') ? ctx.base + h : h)
      }
      case 'icon':
        return icon(String(v ?? ''))
    }
    return ''
  })
}

/**
 * @param {object} input
 * @param {Record<string,string>} input.pages     template name (e.g. "index.html") -> template text
 * @param {Record<string,string>} input.partials  partial name -> text
 * @param {object} input.content                  validated content document
 * @param {Array<{id:string,type:string}>} input.media  media metadata (bytes are written separately)
 * @param {Record<string,string>} [input.fallbacks]  image field path -> default URL
 * @param {string} [input.origin]                 https origin, for share-image URLs
 * @param {string} [input.base]                   prefix for site URLs; '' when served normally,
 *                                                an origin for previews opened from a blob
 * @returns {Record<string,string>} file name -> HTML
 */
export function renderPages({ pages, partials, content, media, fallbacks = {}, base = '', origin = '' }) {
  const ctx = {
    origin,
    content,
    media: new Map(media.map((m) => [m.id, m])),
    fallbacks: new Map(Object.entries(fallbacks)),
    base,
  }
  const out = {}
  for (const [name, raw] of Object.entries(pages)) {
    const id = raw.match(/<!-- page:([a-z0-9-]+) -->/)?.[1] ?? ''
    let html = raw.replace(/^[ \t]*<!-- include:([a-z]+) -->/gm, (_, p) => (partials[p] ?? '').trimEnd())
    html = html.replace(/\{\{current:([a-z0-9-]+)\}\}/g, (_, p) => (p === id ? ' aria-current="page"' : ''))
    html = html.replace(/<!-- page:[a-z0-9-]+ -->\n?/, '')
    html = expand(html, content, ctx)
    if (base) {
      // Previews are opened from a blob: URL, where '/site.css' resolves to
      // nothing and <base> is forbidden by base-uri 'none'. Make the fixed
      // asset links absolute instead.
      html = html.replace(/(href|src)="\/(?!\/)/g, `$1="${base}/`)
    }
    out[name] = html
  }
  return out
}
