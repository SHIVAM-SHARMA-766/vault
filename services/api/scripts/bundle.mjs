// Bundles the handler into a single file for Lambda.
//
// The AWS SDK is bundled rather than taken from the runtime, so that a deploy
// runs against the version in the lockfile and not whatever the runtime
// happens to ship that week. It costs a larger zip and buys reproducibility.

import { rm, mkdir } from 'node:fs/promises'
import { build } from 'esbuild'

const OUT = 'dist-bundle'

await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })

const result = await build({
  entryPoints: ['src/index.ts'],
  outfile: `${OUT}/index.mjs`,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  minify: false, // a readable stack trace is worth more than a smaller zip
  // esbuild cannot infer these for an ESM bundle that pulls in CommonJS deps.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  metafile: true,
})

const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0)
console.log(`bundled to ${OUT}/index.mjs — ${(bytes / 1024 / 1024).toFixed(2)} MB`)
