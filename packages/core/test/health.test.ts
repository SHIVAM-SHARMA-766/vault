// Password health: strength, reuse, age, and unencrypted sites.

import test from 'node:test'
import assert from 'node:assert/strict'

import { analyse, passwordStrength } from '../src/index.js'

test('common, short, repeated and sequential passwords are weak', () => {
  for (const pw of ['password', 'Password123!', 'qwerty', '12345678', 'aaaaaaaaaaaa', 'abcdef123', 'letmein2024']) {
    assert.equal(passwordStrength(pw).label, 'Weak', pw)
  }
})

test('long random and generated passwords are strong', () => {
  assert.ok(passwordStrength('k9#Vt2!mQz@Lr8&w').score >= 3)
  assert.equal(passwordStrength('correct horse battery staple').score >= 3, true)
  assert.equal(passwordStrength('').score, 0)
})

const day = 86_400_000
const NOW = Date.parse('2026-11-07T00:00:00Z')
const iso = (daysAgo: number) => new Date(NOW - daysAgo * day).toISOString()

test('reuse, age and http are found; notes and cards are not checked', () => {
  const r = analyse([
    { id: 'a', type: 'login', password: 'k9#Vt2!mQz@Lr8&w', url: 'https://a.example', updatedAt: iso(1) },
    { id: 'b', type: 'login', password: 'k9#Vt2!mQz@Lr8&w', url: 'https://b.example', updatedAt: iso(1) },
    { id: 'c', type: 'login', password: 'Tr0ub4dour&3xyzQ!', url: 'http://old.example', updatedAt: iso(1) },
    { id: 'd', type: 'login', password: 'Zq8!vN3#pL6@wR1x', updatedAt: iso(1), passwordChangedAt: iso(400) },
    { id: 'e', type: 'wifi', password: 'password', updatedAt: iso(1) },
    { id: 'f', type: 'login', password: 'H7$kQ2!nV9@xM4zp', url: 'http://192.168.1.1', updatedAt: iso(500), passwordChangedAt: iso(2) },
    { id: 'g', type: 'note', updatedAt: iso(900) },
    { id: 'h', type: 'login', updatedAt: iso(900) },
  ], NOW)
  assert.equal(r.checked, 6)
  assert.deepEqual(r.issues.get('a'), ['reused'])
  assert.deepEqual(r.issues.get('b'), ['reused'])
  assert.deepEqual(r.issues.get('c'), ['insecure'])
  assert.deepEqual(r.issues.get('d'), ['old'], 'the password age wins over the last edit')
  assert.deepEqual(r.issues.get('e'), ['weak'])
  assert.equal(r.issues.has('f'), false, 'a local address over http is not flagged; a recent change is not old')
  assert.deepEqual(r.counts, { weak: 1, reused: 2, old: 1, insecure: 1 })
  assert.equal(r.score, 17)
})

test('an empty vault scores 100', () => {
  assert.equal(analyse([]).score, 100)
})
