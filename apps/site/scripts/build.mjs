// Renders the site with its default content into dist/, and refuses to finish
// if any page would break under the policy it is served with — the same
// Content-Security-Policy as the client: no inline script, no inline style, no
// remote resource. The site has no JavaScript at all.
//
// On the host the same templates are rendered by the API with the content
// published from the admin panel (services/api/src/site.ts). This build is what
// proves the templates and the defaults are sound before they ship.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { imageFallbacks, validateContent } from '../lib/content.mjs'
import { renderPages } from '../lib/render.mjs'

const ROOT = new URL('../', import.meta.url).pathname
const DIST = join(ROOT, 'dist')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

const schema = JSON.parse(read('content/schema.json'))
const defaults = JSON.parse(read('content/defaults.json'))
const { content, errors } = validateContent(schema, defaults, defaults)
if (errors.length) {
  console.error('The default content does not satisfy the schema:')
  for (const e of errors) console.error(`  - ${e.path} ${e.message}`)
  process.exit(1)
}

const loadDir = (dir) => Object.fromEntries(
  readdirSync(join(ROOT, dir)).filter((f) => f.endsWith('.html')).map((f) => [f.replace(/\.html$/, ''), read(join(dir, f))]),
)
const partials = loadDir('templates/partials')
const pages = Object.fromEntries(Object.entries(loadDir('templates')).map(([k, v]) => [`${k}.html`, v]))

const out = renderPages({
  pages, partials, content, media: [], fallbacks: imageFallbacks(schema),
  origin: process.env.SITE_ORIGIN ?? 'https://vault-shivam.duckdns.org',
})

rmSync(DIST, { recursive: true, force: true })
mkdirSync(DIST, { recursive: true })
cpSync(join(ROOT, 'static'), DIST, { recursive: true })
for (const [name, html] of Object.entries(out)) writeFileSync(join(DIST, name), html)

const failures = []
for (const [page, html] of Object.entries(out)) {
  if (/<!-- include:|\{\{|\}\}/.test(html)) failures.push(`${page}: an unresolved template marker is left in the output`)
  if (/<script\b/i.test(html)) failures.push(`${page}: has a <script>; the site ships no JavaScript`)
  if (/<style\b/i.test(html)) failures.push(`${page}: has an inline <style> block`)
  if (/\sstyle="/i.test(html)) failures.push(`${page}: has a style attribute`)
  if (/\son[a-z]+="/i.test(html)) failures.push(`${page}: has an inline event handler`)
  if (!/<title>[^<]+<\/title>/.test(html)) failures.push(`${page}: has no <title>`)
  if (!/<meta name="description" content="[^"]+"/.test(html) && page !== '404.html') failures.push(`${page}: has no meta description`)
  for (const m of html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)) {
    // Outbound links are fine; loading something from another origin is not.
    const tag = html.slice(html.lastIndexOf('<', m.index), m.index)
    if (!/^<a\b/i.test(tag)) failures.push(`${page}: loads a remote resource: ${m[1]}`)
  }
  for (const m of html.matchAll(/(?:src|href)="(\/[^"#?]*)(#[^"]*)?"/g)) {
    const path = m[1]
    if (path === '/' || path.startsWith('/app/') || path.startsWith('/api/') || path.startsWith('/media/')) continue
    const file = path.endsWith('/') ? `${path}index.html` : path
    if (![file, `${file}.html`].some((c) => existsSync(join(DIST, c)))) failures.push(`${page}: links to ${path}, which does not exist`)
  }
  for (const m of html.matchAll(/href="(\/[a-z-]*)#([a-z-]+)"/g)) {
    const target = m[1] === '/' ? 'index.html' : `${m[1].slice(1)}.html`
    if (!(out[target] ?? '').includes(`id="${m[2]}"`)) failures.push(`${page}: links to ${m[1]}#${m[2]}, which has no such id`)
  }
}

if (failures.length) {
  console.error('The site would break under its policy:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`site: ${Object.keys(out).length} page(s) from templates, no script, no inline style, no remote resource, no broken link`)
