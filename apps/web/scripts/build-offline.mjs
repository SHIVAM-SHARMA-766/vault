// Bundles the offline copy's script (offline/offline.ts) into dist/offline.js.
// The app downloads it and writes it, with an encrypted copy of the vault,
// into one HTML file (src/lib/offline.ts). It is never run on the served site.

import { build } from 'esbuild'

await build({
  entryPoints: [new URL('../offline/offline.ts', import.meta.url).pathname],
  outfile: new URL('../dist/offline.js', import.meta.url).pathname,
  bundle: true,
  format: 'iife',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  platform: 'browser',
})
console.log('offline copy script: dist/offline.js')
