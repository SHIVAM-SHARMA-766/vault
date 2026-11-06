// Copies the site into dist/ and refuses to finish if any page would break
// under the policy it is served with: the same Content-Security-Policy as the
// client, so no inline script, no inline style, no remote URL. The site has no
// JavaScript at all, which makes the first of those easy to keep.

import { cpSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const SRC = new URL('../src/', import.meta.url).pathname
const DIST = new URL('../dist/', import.meta.url).pathname

rmSync(DIST, { recursive: true, force: true })
cpSync(SRC, DIST, { recursive: true })

const failures = []
const pages = readdirSync(DIST).filter((f) => f.endsWith('.html'))

for (const page of pages) {
  const html = readFileSync(join(DIST, page), 'utf8')
  if (/<script\b/i.test(html)) failures.push(`${page}: has a <script>; the site ships no JavaScript`)
  if (/<style\b/i.test(html)) failures.push(`${page}: has an inline <style> block`)
  if (/\sstyle="/i.test(html)) failures.push(`${page}: has a style attribute`)
  if (/\son[a-z]+="/i.test(html)) failures.push(`${page}: has an inline event handler`)
  for (const m of html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)) {
    // Outbound links are fine; loading something from another origin is not.
    const tag = html.slice(html.lastIndexOf('<', m.index), m.index)
    if (!/^<a\b/i.test(tag)) failures.push(`${page}: loads a remote resource: ${m[1]}`)
  }
  for (const m of html.matchAll(/(?:src|href)="(\/[^"#?]*)"/g)) {
    const path = m[1]
    if (path === '/' || path.startsWith('/app/') || path.startsWith('/api/')) continue
    const file = path.endsWith('/') ? `${path}index.html` : path
    const candidates = [file, `${file}.html`]
    if (!candidates.some((c) => { try { readFileSync(join(DIST, c)); return true } catch { return false } })) {
      failures.push(`${page}: links to ${path}, which does not exist`)
    }
  }
}

if (failures.length) {
  console.error('The site would break under its policy:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`site: ${pages.length} page(s), no script, no inline style, no remote resource`)
