// Writes docs/openapi.json from the routing table. Run after adding or
// changing a route:  npm run openapi --workspace @vault/api
// test/openapi.test.ts fails while the committed file is out of date.

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildRouter } from '../dist/src/app.js'
import { openapi } from '../dist/src/openapi.js'
import { MemoryStore } from '../dist/src/store-memory.js'

const here = dirname(fileURLToPath(import.meta.url))
const router = buildRouter({ store: new MemoryStore(), config: {}, now: Date.now, allowRegistration: false, adminDigests: new Set() })
const out = join(here, '../../../docs/openapi.json')
writeFileSync(out, `${JSON.stringify(openapi(router), null, 2)}\n`)
console.log(`wrote ${out}`)
