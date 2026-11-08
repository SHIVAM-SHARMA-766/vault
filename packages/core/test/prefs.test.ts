// Preferences arrive decrypted but unchecked; every field must come out valid.

import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_PREFS, describeMinutes, describeSeconds, effectiveLockMinutes, normalizePrefs } from '../src/index.js'

test('nothing, or not an object, gives the defaults', () => {
  for (const raw of [undefined, null, 42, 'dark', [], {}]) assert.deepEqual(normalizePrefs(raw), DEFAULT_PREFS)
})

test('valid values are kept', () => {
  const p = { theme: 'dark', lockMinutes: 5, lockOnHide: true, clipboardSeconds: 0, listSort: 'type', density: 'compact', generator: { mode: 'passphrase', length: 32, upper: false, digits: true, symbols: false, words: 7, separator: '.', capitalize: true, digit: true } }
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
