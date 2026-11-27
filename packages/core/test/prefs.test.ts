// Preferences arrive decrypted but unchecked; every field must come out valid.

import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_PREFS, describeMinutes, describeSeconds, effectiveLockMinutes, normalizePrefs, formatWhen, GENERATOR_HISTORY_MAX, rememberGenerated } from '../src/index.js'

test('nothing, or not an object, gives the defaults', () => {
  for (const raw of [undefined, null, 42, 'dark', [], {}]) assert.deepEqual(normalizePrefs(raw), DEFAULT_PREFS)
})

test('valid values are kept', () => {
  const p = { theme: 'dark', lockMinutes: 5, lockOnHide: true, clipboardSeconds: 0, listSort: 'type', density: 'compact', maskLength: 'actual', autoHideSeconds: 0, defaultFolderId: 'abc-1', dateStyle: 'dmy', clock: '12h', language: 'hi', siteIcons: false, generatorHistory: [{ value: 'k9#Vt2!mQz', at: '2026-11-27T10:00:00.000Z' }], templates: [{ id: 'laptop', name: 'Office laptop', base: 'note', fields: [{ label: 'Serial', hidden: false }] }], generator: { mode: 'passphrase', length: 32, upper: false, digits: true, symbols: false, words: 7, separator: '.', capitalize: true, digit: true } }
  assert.deepEqual(normalizePrefs(p), p)
})

test('each bad field falls back on its own, leaving the good ones', () => {
  const p = normalizePrefs({ theme: 'neon', lockMinutes: 7, lockOnHide: 'yes', clipboardSeconds: 30, generator: { length: 'long', upper: false } })
  assert.equal(p.theme, 'system')
  assert.equal(p.lockMinutes, 15)
  assert.equal(p.lockOnHide, false)
  assert.equal(p.clipboardSeconds, 30)
  assert.equal(p.generator.length, 20)
  assert.equal(p.generator.upper, false)
  assert.equal(p.generator.digits, true)
})

test('a generator length outside the range is clamped, a fraction refused', () => {
  assert.equal(normalizePrefs({ generator: { length: 3 } }).generator.length, 8)
  assert.equal(normalizePrefs({ generator: { length: 500 } }).generator.length, 64)
  assert.equal(normalizePrefs({ generator: { length: 12.5 } }).generator.length, 20)
})

test('the idle lock never exceeds a policy, and a policy never lengthens it', () => {
  assert.equal(effectiveLockMinutes({ lockMinutes: 60 }, 10), 10)
  assert.equal(effectiveLockMinutes({ lockMinutes: 5 }, 10), 5)
  assert.equal(effectiveLockMinutes({ lockMinutes: 30 }, null), 30)
  assert.equal(effectiveLockMinutes({ lockMinutes: 30 }, 0), 30)
})

test('the wording reads naturally', () => {
  assert.equal(describeMinutes(1), '1 minute')
  assert.equal(describeMinutes(15), '15 minutes')
  assert.equal(describeMinutes(60), '1 hour')
  assert.equal(describeMinutes(240), '4 hours')
  assert.equal(describeSeconds(0), 'Never')
  assert.equal(describeSeconds(30), '30 seconds')
  assert.equal(describeSeconds(60), '1 minute')
  assert.equal(describeSeconds(120), '2 minutes')
})

test('the defaults cannot be changed by accident', () => {
  assert.throws(() => { (DEFAULT_PREFS as { theme: string }).theme = 'dark' })
})

test('passphrase settings are checked like the rest', () => {
  const g = normalizePrefs({ generator: { mode: 'poem', words: 99, separator: '<script>', capitalize: 'yes' } }).generator
  assert.equal(g.mode, 'password')
  assert.equal(g.words, 12)
  assert.equal(g.separator, '-')
  assert.equal(g.capitalize, false)
})

test('list sort and density default sensibly and refuse anything else', () => {
  assert.equal(normalizePrefs({}).listSort, 'name')
  assert.equal(normalizePrefs({}).density, 'comfortable')
  assert.equal(normalizePrefs({ listSort: 'updated', density: 'compact' }).listSort, 'updated')
  assert.equal(normalizePrefs({ listSort: 'random', density: 'tiny' }).density, 'comfortable')
})

test('reveal, default folder and date options default safely and refuse junk', () => {
  const p = normalizePrefs({})
  assert.deepEqual([p.maskLength, p.autoHideSeconds, p.defaultFolderId, p.dateStyle, p.clock], ['fixed', 30, '', 'system', 'system'])
  const q = normalizePrefs({ maskLength: 'actual', autoHideSeconds: 10, defaultFolderId: 'f6c0e7a2-1b3d-4c5e-8f90-123456789abc', dateStyle: 'ymd', clock: '24h' })
  assert.deepEqual([q.maskLength, q.autoHideSeconds, q.dateStyle, q.clock], ['actual', 10, 'ymd', '24h'])
  assert.equal(q.defaultFolderId, 'f6c0e7a2-1b3d-4c5e-8f90-123456789abc')
  const r = normalizePrefs({ autoHideSeconds: 7, defaultFolderId: '<script>', dateStyle: 'roman', clock: 13 })
  assert.deepEqual([r.autoHideSeconds, r.defaultFolderId, r.dateStyle, r.clock], [30, '', 'system', 'system'])
})

test('dates follow the chosen style and clock; calendar dates never shift by zone', () => {
  const at = '2026-03-04T17:05:00Z'
  const opts = { locale: 'en-GB', timeZone: 'UTC' }
  assert.equal(formatWhen(at, { dateStyle: 'dmy', clock: '24h' }, { ...opts, time: true }), '04/03/2026, 17:05')
  assert.equal(formatWhen(at, { dateStyle: 'mdy', clock: '24h' }, opts), '03/04/2026')
  assert.equal(formatWhen(at, { dateStyle: 'ymd', clock: '12h' }, { ...opts, time: true }).replace(/\s/g, ' '), '2026-03-04, 5:05 pm')
  assert.equal(formatWhen('2026-03-04', { dateStyle: 'dmy', clock: '24h' }, { locale: 'en-GB', timeZone: 'Pacific/Kiritimati', time: true }), '04/03/2026')
  assert.equal(formatWhen('not a date', { dateStyle: 'dmy', clock: '24h' }), 'not a date')
})

test('generator history: newest first, no repeats, capped, and junk dropped on read', () => {
  let h = rememberGenerated([], 'first', new Date('2026-11-27T10:00:00Z'))
  h = rememberGenerated(h, 'second', new Date('2026-11-27T10:01:00Z'))
  h = rememberGenerated(h, 'first', new Date('2026-11-27T10:02:00Z'))
  assert.deepEqual(h.map((x) => x.value), ['first', 'second'])
  assert.equal(h[0]!.at, '2026-11-27T10:02:00.000Z')
  for (let i = 0; i < 30; i++) h = rememberGenerated(h, `p${i}`)
  assert.equal(h.length, GENERATOR_HISTORY_MAX)
  assert.equal(h[0]!.value, 'p29')
  assert.deepEqual(rememberGenerated([], ''), [])
  assert.deepEqual(rememberGenerated([], 'x'.repeat(500)), [], 'nothing absurdly long')

  const read = normalizePrefs({ generatorHistory: [{ value: 'ok', at: '2026-11-27T10:00:00Z' }, { value: 5 }, null, { value: 'bad-date', at: 'never' }, 'str'] })
  assert.deepEqual(read.generatorHistory, [{ value: 'ok', at: '2026-11-27T10:00:00Z' }])
  assert.deepEqual(normalizePrefs({}).generatorHistory, [])
})
