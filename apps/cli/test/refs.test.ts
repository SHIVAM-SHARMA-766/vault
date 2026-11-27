// Secret references and .env templates, without a server.

import test from 'node:test'
import assert from 'node:assert/strict'

import { type Item, fieldOf, findItem, parseEnvTemplate, parseRef, refsIn, substitute } from '../src/refs.js'

const items: Item[] = [
  { id: 'e1', name: 'GitHub', username: 'octo', password: 'gh-secret', customFields: [{ label: 'API key', value: 'ghp_123' }] },
  { id: 'e2', name: 'Prod database', fields: { host: 'db.internal' }, password: 'db pass', customFields: [] },
  { id: 'e3', name: 'Twin', password: 'a', customFields: [] },
  { id: 'e4', name: 'twin', password: 'b', customFields: [] },
]

test('a reference names an item and a field', () => {
  assert.deepEqual(parseRef('vault://GitHub/password'), { item: 'GitHub', field: 'password' })
  assert.deepEqual(parseRef('vault://Prod%2Fdb/fields.host'), { item: 'Prod/db', field: 'fields.host' })
  assert.throws(() => parseRef('https://example.com'), /Not a secret reference/)
})

test('items match by name (any case) or id, never by a guess', () => {
  assert.equal(findItem(items, 'github').id, 'e1')
  assert.equal(findItem(items, 'e2').name, 'Prod database')
  assert.throws(() => findItem(items, 'Twin'), /2 items are named/)
  assert.throws(() => findItem(items, 'Nope'), /No item named/)
})

test('fields: the usual ones, a type\'s own, a custom label', () => {
  assert.equal(fieldOf(items[0]!, 'password'), 'gh-secret')
  assert.equal(fieldOf(items[0]!, 'Username'), 'octo')
  assert.equal(fieldOf(items[0]!, 'api key'), 'ghp_123')
  assert.equal(fieldOf(items[1]!, 'fields.host'), 'db.internal')
  assert.throws(() => fieldOf(items[1]!, 'notes'), /has no notes/)
  assert.throws(() => fieldOf(items[0]!, 'pin'), /has no field "pin"/)
})

test('a .env template: comments, export, quotes; references whole or inside a value', async () => {
  const pairs = parseEnvTemplate('# app\nexport TOKEN="vault://GitHub/API key"\nDB_URL=postgres://u:vault://Prod%20database/password@vault://Prod%20database/fields.host/app\nPLAIN=hello\n')
  assert.deepEqual(pairs.map(([k]) => k), ['TOKEN', 'DB_URL', 'PLAIN'])
  assert.throws(() => parseEnvTemplate('not a pair'), /Not KEY=value/)
  const resolve = async (ref: string) => { const r = parseRef(ref); return fieldOf(findItem(items, r.item), r.field) }
  assert.equal(await substitute(pairs[0]![1], resolve), 'ghp_123')
  assert.equal(await substitute(pairs[1]![1], resolve), 'postgres://u:db pass@db.internal/app')
  assert.equal(await substitute('hello', resolve), 'hello')
  assert.deepEqual(refsIn(pairs[2]![1]), [])
  assert.equal(refsIn(pairs[1]![1]).length, 2)
})
