// Entry and folder sealing, including the identifier binding that stops a
// server from moving ciphertext between records.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_BLOB_BYTES,
  type EntryContent,
  UnsealError,
  generateVaultKey,
  isWithinSizeLimit,
  openEntry,
  openFolder,
  sealEntry,
  sealFolder,
} from '../src/index.js'

const sample = (): EntryContent => ({
  name: 'GitHub',
  type: 'login',
  username: 'person@example.com',
  password: 'hunter2-but-longer',
  url: 'https://github.com',
  notes: 'personal account',
  tags: ['dev', 'work'],
  totpSecret: 'JBSWY3DPEHPK3PXP',
  customFields: [{ label: 'recovery codes', value: '1111 2222', hidden: true }],
  favorite: true,
  folderId: 'folder-1',
})

test('an entry round-trips with every field intact', async () => {
  const vaultKey = generateVaultKey()
  const content = sample()
  const blob = await sealEntry('entry-1', content, vaultKey)
  assert.deepEqual(await openEntry('entry-1', blob, vaultKey), content)
})

test('the blob leaks nothing about the entry', async () => {
  // The name, the URL, and the tags are as sensitive as the password: together
  // they say which services the user holds accounts for.
  const blob = await sealEntry('entry-1', sample(), generateVaultKey())
  for (const secret of ['GitHub', 'github.com', 'person@example.com', 'dev', 'hunter2']) {
    assert.ok(!blob.includes(secret), `blob does not contain ${secret}`)
  }
})

test('an entry cannot be opened under a different id', async () => {
  const vaultKey = generateVaultKey()
  const blob = await sealEntry('entry-1', sample(), vaultKey)
  await assert.rejects(() => openEntry('entry-2', blob, vaultKey), UnsealError)
})

test('an entry blob cannot be passed off as a folder', async () => {
  const vaultKey = generateVaultKey()
  const blob = await sealEntry('shared-id', sample(), vaultKey)
  await assert.rejects(() => openFolder('shared-id', blob, vaultKey), UnsealError)
})

test('a folder round-trips, and nesting is preserved', async () => {
  const vaultKey = generateVaultKey()
  const blob = await sealFolder('folder-1', { name: 'Work', parentId: 'folder-0' }, vaultKey)
  assert.deepEqual(await openFolder('folder-1', blob, vaultKey), { name: 'Work', parentId: 'folder-0' })
})

test('a folder name is not readable from its blob', async () => {
  const blob = await sealFolder('folder-1', { name: 'Offshore Accounts' }, generateVaultKey())
  assert.ok(!blob.includes('Offshore'))
})

test('another vault key cannot open the entry', async () => {
  const blob = await sealEntry('entry-1', sample(), generateVaultKey())
  await assert.rejects(() => openEntry('entry-1', blob, generateVaultKey()), UnsealError)
})

test('the size check rejects an entry too large for a DynamoDB item', async () => {
  const vaultKey = generateVaultKey()
  const small = await sealEntry('entry-1', sample(), vaultKey)
  assert.ok(isWithinSizeLimit(small))

  const huge = { ...sample(), notes: 'x'.repeat(MAX_BLOB_BYTES) }
  assert.equal(isWithinSizeLimit(await sealEntry('entry-1', huge, vaultKey)), false)
})

test('optional fields stay absent rather than becoming empty strings', async () => {
  const vaultKey = generateVaultKey()
  const minimal: EntryContent = {
    name: 'Note', type: 'note', tags: [], customFields: [], favorite: false,
  }
  const opened = await openEntry('n', await sealEntry('n', minimal, vaultKey), vaultKey)
  assert.deepEqual(opened, minimal)
  assert.ok(!('password' in opened))
})
