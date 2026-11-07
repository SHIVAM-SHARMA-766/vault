// Encrypted exports: only the export password opens them, and the file is
// what it claims to be.

import test from 'node:test'
import assert from 'node:assert/strict'

import { UnsealError, isExportFile, openExport, sealExport } from '../src/index.js'

// Low iterations for speed, above the floor openExport accepts.
const IT = 100_000
const payload = { entries: [{ name: 'GitHub', password: 'hunter2' }], folders: [] }

test('the export password opens what it sealed', async () => {
  const file = await sealExport('an export passphrase', payload, IT)
  assert.ok(isExportFile(file))
  assert.deepEqual(await openExport('an export passphrase', file), payload)
})

test('nothing readable is in the file', async () => {
  const file = await sealExport('an export passphrase', payload, IT)
  assert.ok(!file.includes('hunter2') && !file.includes('GitHub'))
})

test('a wrong password or a tampered file fails without saying which', async () => {
  const file = await sealExport('an export passphrase', payload, IT)
  await assert.rejects(openExport('not it', file), UnsealError)
  const parsed = JSON.parse(file)
  parsed.data = parsed.data.slice(0, -4) + 'AAAA'
  await assert.rejects(openExport('an export passphrase', JSON.stringify(parsed)), UnsealError)
})

test('files that are not exports, or claim absurd parameters, are refused', async () => {
  assert.equal(isExportFile('name,url,username,password'), false)
  await assert.rejects(openExport('x', '{"format":"other"}'), UnsealError)
  const file = JSON.parse(await sealExport('p', payload, IT))
  file.kdf.iterations = 1
  await assert.rejects(openExport('p', JSON.stringify(file)), UnsealError)
  file.kdf.iterations = IT
  file.version = 2
  await assert.rejects(openExport('p', JSON.stringify(file)), UnsealError)
})
