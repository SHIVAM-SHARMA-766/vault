// Asserts that the built client can run under the policy it is served with.
//
// The deployed Content-Security-Policy has no 'unsafe-inline' and no
// 'unsafe-eval'. A build that violates it does not fail loudly — the page is
// blank and the reason is only in the browser console, which nobody is
// watching during a deploy. So it is checked here instead.
//
// The policy itself lives in infra/cloud-init.yaml.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const DIST = new URL('../dist/', import.meta.url).pathname
const failures = []

const html = readFileSync(join(DIST, 'index.html'), 'utf8')

// script-src 'self': every script comes from a file, none from the page.
for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
  if (match[1].trim()) failures.push('index.html contains an inline <script>')
}

// style-src 'self': the same for stylesheets.
if (/<style\b/.test(html)) failures.push('index.html contains an inline <style> block')
for (const match of html.matchAll(/\sstyle="([^"]*)"/g)) {
  if (match[1].trim()) failures.push(`index.html has a style attribute: ${match[1].slice(0, 40)}`)
}

// default-src 'none', img-src 'self' data:. Anything reaching another origin
// is blocked — and fetching a favicon from a third party would tell that third
// party which services the vault holds accounts for.
for (const match of html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)) {
  failures.push(`index.html references a remote URL: ${match[1]}`)
}

const assets = readdirSync(join(DIST, 'assets')).filter((f) => f.endsWith('.js'))
if (assets.length === 0) failures.push('no javascript was emitted')

for (const file of assets) {
  const js = readFileSync(join(DIST, 'assets', file), 'utf8')
  for (const pattern of [/\beval\s*\(/, /\bnew\s+Function\s*\(/]) {
    if (pattern.test(js)) {
      failures.push(`${file} uses ${pattern.source}, which would need 'unsafe-eval'`)
    }
  }
}

if (failures.length > 0) {
  console.error('The build violates the policy it is served under:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}

console.log(`policy-clean: ${assets.length} script(s), no inline script, style, or eval`)
