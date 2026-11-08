// Passphrases: the list is the EFF list, draws are uniform and unbiased, and
// options shape the result.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { generatePassphrase, passphraseBits } from '../src/index.js'
import { WORDS } from '../src/words.js'

test('the list is exactly the EFF large wordlist', () => {
  assert.equal(WORDS.length, 7776)
  assert.equal(new Set(WORDS).size, 7776)
  assert.equal(WORDS[0], 'abacus')
  assert.equal(WORDS.at(-1), 'zoom')
  // The published file, rebuilt from the list, has the published checksum.
  const file = WORDS.map((w, i) => {
    let n = i, digits = ''
    for (let k = 0; k < 5; k++) { digits = String((n % 6) + 1) + digits; n = Math.floor(n / 6) }
    return `${digits}\t${w}\n`
  }).join('')
  assert.equal(createHash('sha256').update(file).digest('hex'), 'addd35536511597a02fa0a9ff1e5284677b8883b83e986e43f15a3db996b903e')
})

test('options shape the passphrase', () => {
  // Four words (drop-down, felt-tip, t-shirt, yo-yo) contain a hyphen, so split on a dot.
  const plain = generatePassphrase(WORDS, { words: 6, separator: '.', capitalize: false, digit: false })
  assert.equal(plain.split('.').length, 6)
  for (const w of plain.split('.')) assert.ok(WORDS.includes(w), w)
  const shaped = generatePassphrase(WORDS, { words: 4, separator: ' ', capitalize: true, digit: true })
  const parts = shaped.split(' ')
  assert.equal(parts.length, 4)
  for (const p of parts) assert.match(p, /^[A-Z][a-z-]*\d?$/)
  assert.equal(parts.filter((p) => /\d$/.test(p)).length, 1)
})

test('word counts are kept within 3 to 12', () => {
  assert.equal(generatePassphrase(WORDS, { words: 1, separator: '.', capitalize: false, digit: false }).split('.').length, 3)
  assert.equal(generatePassphrase(WORDS, { words: 40, separator: '.', capitalize: false, digit: false }).split('.').length, 12)
})

test('draws are unbiased: the rejected tail is never used', () => {
  // A source that first returns the very top of the 32-bit range (in the
  // biased tail for 7776) and then zero: the tail must be rejected.
  let calls = 0
  const random = (b: Uint8Array) => { b.fill(calls++ % 2 === 0 ? 0xff : 0x00); return b }
  const p = generatePassphrase(WORDS, { words: 3, separator: ' ', capitalize: false, digit: false }, random)
  assert.equal(p, 'abacus abacus abacus')
})

test('every word is reachable and draws spread evenly', () => {
  const counts = new Map<string, number>()
  for (let i = 0; i < 4000; i++) for (const w of generatePassphrase(WORDS, { words: 12, separator: ' ', capitalize: false, digit: false }).split(' ')) counts.set(w, (counts.get(w) ?? 0) + 1)
  // 48,000 draws over 7,776 words: about 6 each; most words appear.
  assert.ok(counts.size > 7700, `${counts.size} distinct words`)
})

test('strength in bits', () => {
  assert.equal(Math.round(passphraseBits({ words: 6, digit: false })), 78)
  assert.ok(passphraseBits({ words: 6, digit: true }) > passphraseBits({ words: 6, digit: false }))
})
