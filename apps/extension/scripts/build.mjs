// Builds the extension for Chrome and Firefox from one source (decisions/0029).
//
//   dist/chrome/    load unpacked in Chrome, or zip for the Web Store
//   dist/firefox/   load as a temporary add-on, or sign for AMO
//   dist/*.zip      the same, zipped, for a release
//
// The two differ only in the manifest's background entry. With --test, also
// dist/chrome-test/: the Chrome build plus host permission for 127.0.0.1 and
// localhost, so browser tests can fill pages and reach the dev stack without
// a permission prompt nobody can click. It is never shipped.

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { build } from 'esbuild'

const root = new URL('../', import.meta.url).pathname
const dist = `${root}dist`
const test = process.argv.includes('--test')
const { version } = JSON.parse(readFileSync(`${root}package.json`, 'utf8'))

const base = {
  manifest_version: 3,
  name: 'Vault',
  version,
  description: 'Fill passwords from your own Vault server. Zero-knowledge: decrypted only on this device.',
  icons: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
  action: { default_popup: 'popup.html', default_title: 'Vault', default_icon: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' } },
  // No standing access to websites: a page is touched only when the person
  // clicks the button or presses the shortcut (activeTab).
  permissions: ['storage', 'alarms', 'activeTab', 'scripting'],
  // Asked for at first run, for the person's own server origin only.
  optional_host_permissions: ['https://*/*', 'http://*/*'],
  commands: {
    'fill-login': { suggested_key: { default: 'Ctrl+Shift+L', mac: 'Command+Shift+L' }, description: 'Fill the login for this page' },
  },
  content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'" },
}

const manifests = {
  chrome: { ...base, minimum_chrome_version: '116', background: { service_worker: 'background.js', type: 'module' } },
  firefox: {
    ...base,
    background: { scripts: ['background.js'], type: 'module' },
    // Nothing is collected: the extension talks only to the person's own server.
    browser_specific_settings: { gecko: { id: '{6f0b7a52-3c1e-4d55-9a0e-2f7f1b0c9d41}', strict_min_version: '128.0', data_collection_permissions: { required: ['none'] } } },
  },
}
if (test) {
  manifests['chrome-test'] = { ...manifests.chrome, name: 'Vault (test build)', host_permissions: ['http://127.0.0.1/*', 'http://localhost/*'] }
}

// What ships must not grow standing access to websites or a looser policy
// without someone changing this check on purpose.
for (const [name, m] of Object.entries(manifests)) {
  if (name === 'chrome-test') continue
  const problems = []
  if (m.host_permissions) problems.push('host_permissions')
  if (m.content_scripts) problems.push('content_scripts')
  if (m.externally_connectable) problems.push('externally_connectable')
  if (m.web_accessible_resources) problems.push('web_accessible_resources')
  if (m.permissions.some((p) => !['storage', 'alarms', 'activeTab', 'scripting'].includes(p))) problems.push(`permissions ${m.permissions}`)
  if (m.content_security_policy.extension_pages !== "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'") problems.push('content_security_policy')
  if (problems.length) throw new Error(`${name} manifest: ${problems.join(', ')} (decisions/0029)`)
}

rmSync(dist, { recursive: true, force: true })

/** The background and popup are modules; the inline content script is a
 *  classic script, because the browser injects it into pages as one. The test
 *  build compiles with __VAULT_TEST__ (loopback-only inline permission, an open
 *  shadow root the browser test can see into); what ships has it false. */
async function bundle(out, test) {
  const common = {
    bundle: true, target: 'es2022', platform: 'browser', minify: true, legalComments: 'none',
    define: { 'process.env.NODE_ENV': '"production"', __VAULT_TEST__: String(test) },
  }
  await build({ ...common, entryPoints: { background: `${root}src/background.ts`, popup: `${root}src/popup/popup.tsx` }, outdir: out, format: 'esm' })
  await build({ ...common, entryPoints: { content: `${root}src/content.ts` }, outdir: out, format: 'iife' })
}
await bundle(`${dist}/.bundle`, false)
if (test) await bundle(`${dist}/.bundle-test`, true)

for (const [name, manifest] of Object.entries(manifests)) {
  const dir = `${dist}/${name}`
  mkdirSync(`${dir}/icons`, { recursive: true })
  cpSync(name === 'chrome-test' ? `${dist}/.bundle-test` : `${dist}/.bundle`, dir, { recursive: true })
  cpSync(`${root}icons`, `${dir}/icons`, { recursive: true, filter: (p) => !p.endsWith('.svg') })
  cpSync(`${root}src/popup/popup.html`, `${dir}/popup.html`)
  cpSync(`${root}src/popup/popup.css`, `${dir}/popup.css`)
  writeFileSync(`${dir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`)
  if (name !== 'chrome-test') {
    try { execFileSync('zip', ['-qr', `${dist}/vault-extension-${name}-${version}.zip`, '.'], { cwd: dir }) }
    catch { /* zip is optional locally; the release job has it */ }
  }
}
rmSync(`${dist}/.bundle`, { recursive: true, force: true })
rmSync(`${dist}/.bundle-test`, { recursive: true, force: true })
console.log(`extension ${version}: ${Object.keys(manifests).map((n) => `dist/${n}`).join(', ')}`)
