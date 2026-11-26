// Store packages (decisions/0029, stage 4). After `npm run build`:
//
//   dist/vault-extension-chrome-<v>.zip    the Chrome Web Store upload
//   dist/vault-extension-firefox-<v>.zip   the addons.mozilla.org upload
//   dist/vault-extension-source-<v>.zip    the source AMO asks for, because the
//                                          bundles are minified; with
//                                          store/BUILD-FOR-REVIEWERS.md
//   dist/SHA256SUMS                        all three
//
// The build is reproducible (build.mjs), so a reviewer who follows the steps
// gets the same bytes as the uploaded package.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const ext = new URL('../', import.meta.url).pathname
const repo = new URL('../../../', import.meta.url).pathname
const { version } = JSON.parse(readFileSync(`${ext}package.json`, 'utf8'))
const dist = `${ext}dist`
const packages = ['chrome', 'firefox'].map((n) => `vault-extension-${n}-${version}.zip`)
for (const p of packages) if (!existsSync(`${dist}/${p}`)) throw new Error(`${p} is missing: run npm run build first`)

// Everything the build reads, as committed (tracked files only, no secrets,
// no node_modules): the workspace root, the extension and the two packages it uses.
// The extension also compiles two files from the web app (the grant checks and
// the secret-key store), so that both clients run the same code.
const paths = ['package.json', 'package-lock.json', 'apps/extension', 'packages/crypto', 'packages/core', 'apps/web/src/features/orgs/grants.ts', 'apps/web/src/lib/secretkey.ts']
const files = execFileSync('git', ['ls-files', '--', ...paths], { cwd: repo, encoding: 'utf8' }).split('\n').filter(Boolean).sort()
const stage = mkdtempSync(join(tmpdir(), 'vault-ext-src-'))
for (const f of files) { mkdirSync(dirname(join(stage, f)), { recursive: true }); cpSync(join(repo, f), join(stage, f)) }
cpSync(`${ext}store/BUILD-FOR-REVIEWERS.md`, join(stage, 'BUILD-FOR-REVIEWERS.md'))
const listed = [...files, 'BUILD-FOR-REVIEWERS.md'].sort()
execFileSync('touch', ['-h', '-d', '1980-01-01T00:00:00Z', ...listed], { cwd: stage })
const source = `vault-extension-source-${version}.zip`
rmSync(`${dist}/${source}`, { force: true })
execFileSync('zip', ['-q', '-X', '-D', '-9', `${dist}/${source}`, '-@'], { cwd: stage, input: listed.join('\n'), env: { ...process.env, TZ: 'UTC' } })
rmSync(stage, { recursive: true, force: true })

const sums = [...packages, source].map((p) => `${createHash('sha256').update(readFileSync(`${dist}/${p}`)).digest('hex')}  ${p}`).join('\n')
writeFileSync(`${dist}/SHA256SUMS`, `${sums}\n`)
console.log(sums)
