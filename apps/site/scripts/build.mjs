// Builds the site into dist/ and refuses to finish if any page would break
// under the policy it is served with — the same Content-Security-Policy as the
// client: no inline script, no inline style, no remote resource. The site has
// no JavaScript at all, which makes the first of those easy to keep.
//
// Pages are plain HTML with three build-time markers, so the header and footer
// exist once rather than once per page:
//
//   <!-- page:features -->        which page this is, for the nav highlight
//   <!-- include:header -->       replaced with src/partials/header.html
//   {{current:features}}          (in partials) aria-current on the active link

import { cpSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const SRC = new URL('../src/', import.meta.url).pathname
const DIST = new URL('../dist/', import.meta.url).pathname

rmSync(DIST, { recursive: true, force: true })
cpSync(SRC, DIST, { recursive: true, filter: (p) => !p.includes('/partials') })

const partial = (name) => readFileSync(join(SRC, 'partials', `${name}.html`), 'utf8').trimEnd()
const failures = []
const pages = readdirSync(DIST).filter((f) => f.endsWith('.html'))

for (const page of pages) {
  let html = readFileSync(join(DIST, page), 'utf8')
  const id = html.match(/<!-- page:([a-z-]+) -->/)?.[1] ?? ''
  html = html.replace(/^[ \t]*<!-- include:([a-z]+) -->/gm, (_, name) => partial(name))
  html = html.replace(/\{\{current:([a-z-]+)\}\}/g, (_, name) => (name === id ? ' aria-current="page"' : ''))
  html = html.replace(/<!-- page:[a-z-]+ -->\n?/, '')
  if (/<!-- include:|\{\{/.test(html)) failures.push(`${page}: an unresolved build marker is left in the output`)
  writeFileSync(join(DIST, page), html)

  if (/<script\b/i.test(html)) failures.push(`${page}: has a <script>; the site ships no JavaScript`)
  if (/<style\b/i.test(html)) failures.push(`${page}: has an inline <style> block`)
  if (/\sstyle="/i.test(html)) failures.push(`${page}: has a style attribute`)
  if (/\son[a-z]+="/i.test(html)) failures.push(`${page}: has an inline event handler`)
  if (!/<title>[^<]+<\/title>/.test(html)) failures.push(`${page}: has no <title>`)
  if (!/<meta name="description"/.test(html) && page !== '404.html') failures.push(`${page}: has no meta description`)
  for (const m of html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)) {
    // Outbound links are fine; loading something from another origin is not.
    const tag = html.slice(html.lastIndexOf('<', m.index), m.index)
    if (!/^<a\b/i.test(tag)) failures.push(`${page}: loads a remote resource: ${m[1]}`)
  }
  for (const m of html.matchAll(/(?:src|href)="(\/[^"#?]*)(#[^"]*)?"/g)) {
    const path = m[1]
    if (path === '/' || path.startsWith('/app/') || path.startsWith('/api/')) continue
    const file = path.endsWith('/') ? `${path}index.html` : path
    if (![file, `${file}.html`].some((c) => existsSync(join(DIST, c)))) {
      failures.push(`${page}: links to ${path}, which does not exist`)
    }
  }
  // An anchor to another page must name an id that page has.
  for (const m of html.matchAll(/href="(\/[a-z-]*)#([a-z-]+)"/g)) {
    const target = m[1] === '/' ? 'index.html' : `${m[1].slice(1)}.html`
    const other = existsSync(join(SRC, target)) ? readFileSync(join(SRC, target), 'utf8') : ''
    if (!other.includes(`id="${m[2]}"`)) failures.push(`${page}: links to ${m[1]}#${m[2]}, which has no such id`)
  }
}

if (failures.length) {
  console.error('The site would break under its policy:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`site: ${pages.length} page(s), no script, no inline style, no remote resource, no broken link`)
