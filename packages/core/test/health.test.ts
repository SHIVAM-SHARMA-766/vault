// Password health: strength, reuse, age, and unencrypted sites.

import test from 'node:test'
import assert from 'node:assert/strict'

import { STRENGTH_LABELS, analyse, belowMinimum, breachCount, expiryOf, passwordStrength } from '../src/index.js'

test('common, short, repeated and sequential passwords are weak', () => {
  for (const pw of ['password', 'Password123!', 'qwerty', '12345678', 'aaaaaaaaaaaa', 'abcdef123', 'letmein2024', 'summer2024', 'Pune@123', 'Rahul1990!']) {
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
  assert.deepEqual(r.counts, { breached: 0, exposed: 0, weak: 1, reused: 2, old: 1, insecure: 1, expired: 0, expiring: 0 })
  assert.equal(r.score, 17)
})

test('an empty vault scores 100', () => {
  assert.equal(analyse([]).score, 100)
})

test('belowMinimum explains a password under a policy floor and passes one above it', () => {
  assert.equal(belowMinimum('anything', 0), null, 'no floor, no complaint')
  assert.match(String(belowMinimum('password1', 3)), /at least Strong/)
  assert.equal(belowMinimum('correct horse battery staple orbit lantern', 3), null)
  assert.equal(STRENGTH_LABELS.length, 5)
})

test('database and server passwords count for reuse; wallet passwords and PINs do not', () => {
  const r = analyse([
    { id: 'a', type: 'login', password: 'shared-but-long-Passw0rd!', updatedAt: new Date().toISOString() },
    { id: 'b', type: 'database', password: 'shared-but-long-Passw0rd!', updatedAt: new Date().toISOString() },
    { id: 'c', type: 'cryptoWallet', password: 'shared-but-long-Passw0rd!', updatedAt: new Date().toISOString() },
  ])
  assert.equal(r.counts.reused, 2)
})

test('a breached password is an issue and lowers the score; expiry is listed but not scored', () => {
  const now = Date.UTC(2026, 10, 8)
  const fresh = new Date(now).toISOString()
  const r = analyse([
    { id: 'a', type: 'login', password: 'unique-and-Long-Passw0rd!x', updatedAt: fresh },
    { id: 'b', type: 'login', password: 'another-unique-Long-pw-9Q', updatedAt: fresh },
    { id: 'p', type: 'passport', updatedAt: fresh, fields: { expires: '2026-11-01' } },
    { id: 'c', type: 'card', updatedAt: fresh, fields: { expiry: '11/26' } },
    { id: 'k', type: 'apiCredential', updatedAt: fresh, fields: { expires: '2027-06-01' } },
  ], now, new Set(['a']))
  assert.deepEqual(r.issues.get('a'), ['breached'])
  assert.equal(r.score, 50)
  assert.deepEqual(r.issues.get('p'), ['expired'])
  assert.deepEqual(r.issues.get('c'), ['expiring'], 'a card valid through November is expiring, not expired')
  assert.equal(r.issues.has('k'), false)
  assert.equal(r.failing, 1)
  assert.deepEqual([r.counts.breached, r.counts.expired, r.counts.expiring], [1, 1, 1])
})

test('expiry dates: ISO dates end at the end of their day, card dates at the end of their month', () => {
  assert.equal(new Date(expiryOf({ type: 'passport', fields: { expires: '2030-02-28' } })!).toISOString(), '2030-02-28T23:59:59.999Z')
  assert.equal(new Date(expiryOf({ type: 'card', fields: { expiry: '02/28' } })!).toISOString(), '2028-02-29T23:59:59.999Z')
  assert.equal(expiryOf({ type: 'card', fields: { expiry: '13/28' } }), null)
  assert.equal(expiryOf({ type: 'login' }), null)
})

test('breach counts are read from a range response, padding and case aside', () => {
  const body = '0018A45C4D1DEF81644B54AB7F969B88D65:3\r\n00D4F6E8FA6EECAD2A3AA415EEC418D38EC:0\r\n011053FD0102E94D6AE2F8B83D76FAF94F6:12\r\n'
  assert.equal(breachCount(body, '011053fd0102e94d6ae2f8b83d76faf94f6'), 12)
  assert.equal(breachCount(body, '00D4F6E8FA6EECAD2A3AA415EEC418D38EC'), 0)
  assert.equal(breachCount(body, 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF'), 0)
})

test('a shared password seen by someone who left is an issue, and is scored', () => {
  const fresh = new Date().toISOString()
  const r = analyse([{ id: 's', type: 'login', password: 'unique-and-Long-Passw0rd!x', updatedAt: fresh }], Date.now(), new Set(), new Set(['s']))
  assert.deepEqual(r.issues.get('s'), ['exposed'])
  assert.equal(r.score, 0)
})
