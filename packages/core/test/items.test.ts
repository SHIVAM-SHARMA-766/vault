// The item model: type fields, where values live, search, card helpers, and
// folder trees that survive missing parents and cycles.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TYPE_SPECS, cardBrand, depthOf, descendants, flattenTree, folderPath, folderTree,
  formatCardNumber, formatDate, isPast, matches, readField, subtitle, typeSpec, typesByGroup, writeField,
} from '../src/index.js'

test('every type has a spec, and field keys are unique within it', () => {
  for (const t of ['login', 'note', 'card', 'identity', 'bankAccount', 'sshKey', 'wifi']) {
    const spec = typeSpec(t)
    assert.equal(spec.type, t)
    assert.equal(new Set(spec.fields.map((x) => x.key)).size, spec.fields.length)
  }
  assert.equal(typeSpec('nonsense').type, 'login')
})

test('login and Wi-Fi keep username and password at the top level, so old entries read', () => {
  const wifi = { name: 'Home', type: 'wifi', username: 'Lighthouse', password: 'p' }
  const ssid = typeSpec('wifi').fields.find((x) => x.key === 'username')!
  assert.equal(readField(wifi, ssid), 'Lighthouse')
})

test('writeField puts type-specific values in fields and never mutates', () => {
  const card: { name: string; type: string; fields?: Record<string, string> } = { name: 'Visa', type: 'card' }
  const number = typeSpec('card').fields.find((x) => x.key === 'number')!
  const next = writeField(card, number, '4111111111111111')
  assert.deepEqual(next.fields, { number: '4111111111111111' })
  assert.equal(card.fields, undefined)
})

test('subtitles never show a secret', () => {
  assert.equal(subtitle({ name: 'c', type: 'card', fields: { number: '4111 1111 1111 1234' } }), 'Visa •••• 1234')
  assert.equal(subtitle({ name: 'b', type: 'bankAccount', fields: { bankName: 'HDFC', accountNumber: '999' } }), 'HDFC')
  assert.equal(subtitle({ name: 'l', type: 'login', url: 'https://github.com/login' }), 'github.com')
  for (const spec of TYPE_SPECS) {
    const sub = spec.fields.find((x) => x.key === spec.subtitle)
    if (sub) assert.notEqual(sub.kind, 'secret', `${spec.type} subtitle is not a secret`)
  }
})

test('search finds visible fields, tags, folders and custom fields, never secrets', () => {
  const e = {
    name: 'Prod DB', type: 'login', username: 'admin', password: 'hunter2', tags: ['work'],
    customFields: [{ label: 'Port', value: '5432', hidden: false }, { label: 'Root', value: 'topsecret', hidden: true }],
  }
  assert.ok(matches(e, 'prod'))
  assert.ok(matches(e, 'ADMIN'))
  assert.ok(matches(e, 'work'))
  assert.ok(matches(e, '5432'))
  assert.ok(matches(e, 'servers', 'Work / Servers'))
  assert.ok(!matches(e, 'hunter'))
  assert.ok(!matches(e, 'topsecret'))
  assert.ok(matches(e, ''))
})

test('card brands and formatting', () => {
  assert.equal(cardBrand('4111 1111 1111 1111'), 'Visa')
  assert.equal(cardBrand('5555555555554444'), 'Mastercard')
  assert.equal(cardBrand('378282246310005'), 'Amex')
  assert.equal(cardBrand('6521000000000000'), 'RuPay')
  assert.equal(cardBrand('9999'), null)
  assert.equal(formatCardNumber('4111111111111111'), '4111 1111 1111 1111')
  assert.equal(formatCardNumber('378282246310005'), '3782 822463 10005')
})

const folders = [
  { id: 'w', name: 'Work' },
  { id: 's', name: 'Servers', parentId: 'w' },
  { id: 'a', name: 'AWS', parentId: 's' },
  { id: 'h', name: 'Home' },
  { id: 'o', name: 'Orphan', parentId: 'deleted' },
  { id: 'x', name: 'Cycle X', parentId: 'y' },
  { id: 'y', name: 'Cycle Y', parentId: 'x' },
]

test('folder trees nest, sort, and keep orphans and cycles visible', () => {
  const flat = flattenTree(folderTree(folders))
  assert.equal(flat.length, folders.length, 'every folder appears exactly once')
  const roots = flat.filter((n) => n.depth === 0).map((n) => n.folder.name)
  for (const name of ['Home', 'Orphan', 'Work']) assert.ok(roots.includes(name), name)
  assert.ok(roots.includes('Cycle X') || roots.includes('Cycle Y'), 'a cycle is broken into a root')
  assert.equal(flat.find((n) => n.folder.id === 'a')?.depth, 2)
  assert.equal(flat.find((n) => n.folder.id === 'o')?.depth, 0)
})

test('paths, depth and descendants', () => {
  assert.equal(folderPath(folders, 'a'), 'Work / Servers / AWS')
  assert.equal(depthOf(folders, 'a'), 3)
  assert.equal(depthOf(folders, undefined), 0)
  assert.deepEqual([...descendants(folders, 'w')].sort(), ['a', 's', 'w'])
})

test('every type belongs to a picker group, and every group has types', () => {
  const groups = typesByGroup()
  assert.equal(groups.reduce((n, g) => n + g.types.length, 0), TYPE_SPECS.length)
  for (const g of groups) assert.ok(g.types.length > 0, g.group)
  assert.equal(new Set(TYPE_SPECS.map((t) => t.type)).size, TYPE_SPECS.length, 'no type twice')
})

test('the new types read and write their fields, and name a subtitle field they have', () => {
  for (const t of ['apiCredential', 'database', 'server', 'softwareLicense', 'passport', 'driverLicense', 'membership', 'cryptoWallet']) {
    const spec = typeSpec(t)
    assert.equal(spec.type, t)
    if (spec.subtitle) assert.ok(spec.fields.some((x) => x.key === spec.subtitle), `${t} subtitle`)
    const keys = spec.fields.map((x) => x.key)
    assert.equal(new Set(keys).size, keys.length, `${t} has no duplicate field`)
  }
  const db = typeSpec('database')
  let e: Record<string, unknown> = { name: 'Prod DB', type: 'database' }
  for (const field of db.fields) e = writeField(e as never, field, field.key === 'engine' ? 'postgresql' : `v-${field.key}`) as Record<string, unknown>
  assert.equal(e['username'], 'v-username', 'username stays top-level, so login-style tools find it')
  assert.equal((e['fields'] as Record<string, string>)['host'], 'v-host')
  assert.equal(subtitle(e as never), 'v-host')
})

test('dates format by locale and know when they are past', () => {
  assert.equal(formatDate('2031-04-09', 'en-GB'), '9 Apr 2031')
  assert.equal(formatDate('09/04/2031'), '09/04/2031', 'free text is shown as typed')
  const now = Date.UTC(2026, 10, 8)
  assert.equal(isPast('2026-11-07', now), true)
  assert.equal(isPast('2026-11-08', now), false, 'the day itself has not passed')
  assert.equal(isPast('soon', now), false)
})
