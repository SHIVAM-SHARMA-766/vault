// Site matching for autofill (decisions/0029): the line between a login form
// and a phishing page. Expected registrable domains follow the Public Suffix
// List's own test cases (tests/test_psl.txt in the list's repository).

import test from 'node:test'
import assert from 'node:assert/strict'

import { matchSite, rankForPage, registrableDomain } from '../src/index.js'

test('registrable domains, from the Public Suffix List test cases', () => {
  const cases: [string, string | null][] = [
    ['com', null],
    ['example.com', 'example.com'],
    ['b.example.com', 'example.com'],
    ['a.b.example.com', 'example.com'],
    ['uk.com', null],
    ['example.uk.com', 'example.uk.com'],
    ['b.example.uk.com', 'example.uk.com'],
    ['co.uk', null],
    ['example.co.uk', 'example.co.uk'],
    ['www.example.co.uk', 'example.co.uk'],
    ['example.co.in', 'example.co.in'],
    ['mail.example.co.in', 'example.co.in'],
    // Wildcard and exception rules (*.ck, !www.ck).
    ['ck', null],
    ['test.ck', null],
    ['b.test.ck', 'b.test.ck'],
    ['a.b.test.ck', 'b.test.ck'],
    ['www.ck', 'www.ck'],
    ['www.www.ck', 'www.ck'],
    // Private section: each user's site is its own domain.
    ['github.io', null],
    ['alice.github.io', 'alice.github.io'],
    ['www.alice.github.io', 'alice.github.io'],
    // Unlisted TLDs fall back to the default rule "*".
    ['example.example', 'example.example'],
    ['b.example.example', 'example.example'],
    // IDN, in the ASCII form URL.hostname gives (公司.cn, 食狮.公司.cn).
    ['xn--55qx5d.cn', null],
    ['xn--85x722f.xn--55qx5d.cn', 'xn--85x722f.xn--55qx5d.cn'],
    ['WWW.Example.COM.', 'example.com'],
    // No registrable domain at all.
    ['localhost', null],
    ['127.0.0.1', null],
    ['[::1]', null],
  ]
  for (const [host, expected] of cases) assert.equal(registrableDomain(host), expected, host)
})

test('origin and domain matches', () => {
  assert.equal(matchSite('https://example.com/login', 'https://example.com/account'), 'origin')
  assert.equal(matchSite('example.com', 'https://example.com/'), 'origin', 'a bare host means https')
  assert.equal(matchSite('https://accounts.example.com', 'https://www.example.com/signin'), 'domain')
  assert.equal(matchSite('https://example.co.uk', 'https://login.example.co.uk'), 'domain')
  assert.equal(matchSite('http://example.com', 'https://example.com'), 'domain', 'http item, same site over https: an upgrade')
})

test('look-alikes, neighbours and downgrades get nothing', () => {
  const item = 'https://example.com/login'
  for (const page of [
    'https://example.com.evil.io/login',
    'https://examplee.com/',
    'https://example.co/',
    'https://xn--exmple-cua.com/', // exämple.com
    'http://example.com/login', // https item, http page
    'https://example.com@evil.io/',
    'file:///home/me/example.com.html',
    'javascript:alert(1)',
    'not a url',
  ]) assert.equal(matchSite(item, page), null, page)

  assert.equal(matchSite('https://alice.github.io', 'https://mallory.github.io'), null, 'neighbours on a shared suffix')
  assert.equal(matchSite('https://co.uk', 'https://evil.co.uk'), null, 'a public suffix is no one\'s domain')
  assert.equal(matchSite('', 'https://example.com'), null)
  assert.equal(matchSite(undefined, 'https://example.com'), null)
})

test('addresses and local names match by origin only, port included', () => {
  assert.equal(matchSite('http://127.0.0.1:8080/', 'http://127.0.0.1:8080/login'), 'origin')
  assert.equal(matchSite('http://127.0.0.1:8080/', 'http://127.0.0.1:9090/login'), null)
  assert.equal(matchSite('https://10.0.0.5', 'https://10.0.0.6'), null)
  assert.equal(matchSite('http://localhost:3000', 'http://localhost:3000/x'), 'origin')
  assert.equal(matchSite('http://localhost:3000', 'http://localhost:4000/x'), null)
  assert.equal(matchSite('https://nas', 'https://nas/'), 'origin')
})

test('ranking: origin matches first, then most recently used', () => {
  const items = [
    { id: 'old-domain', url: 'https://example.com', used: 1 },
    { id: 'origin', url: 'https://www.example.com', used: 0 },
    { id: 'new-domain', url: 'https://accounts.example.com', used: 5 },
    { id: 'other', url: 'https://other.com', used: 9 },
  ]
  const ranked = rankForPage(items, 'https://www.example.com/login', (i) => i.url, (i) => i.used).map((i) => i.id)
  assert.deepEqual(ranked, ['origin', 'new-domain', 'old-domain'])
})
