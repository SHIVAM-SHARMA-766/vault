// Error wording: every failure says what happened and what to do next.

import test from 'node:test'
import assert from 'node:assert/strict'

import { friendlyError } from '../src/index.js'

test('no connection', () => {
  assert.match(friendlyError({ status: 0, code: 'network', message: 'x' }), /Check your internet connection/)
})

test('a proxy page or a restarting server', () => {
  for (const status of [502, 503, 504]) assert.match(friendlyError({ status, code: 'error', message: '' }), /restarting or updating/)
  assert.match(friendlyError({ status: 200, code: 'malformed', message: '' }), /restarting/)
})

test('rate limits say how long to wait', () => {
  assert.match(friendlyError({ status: 429, code: 'rate_limited', message: '', retryAfter: 30 }), /Wait 30 seconds/)
  assert.match(friendlyError({ status: 429, code: 'rate_limited', message: '', retryAfter: 60 }), /Wait a minute/)
  assert.match(friendlyError({ status: 429, code: 'rate_limited', message: '', retryAfter: 600 }), /Wait 10 minutes/)
  assert.match(friendlyError({ status: 429, code: 'rate_limited', message: '' }), /Wait a few minutes/)
})

test('a server fault: nothing changed, a reference, and who to tell', () => {
  const text = friendlyError({ status: 500, code: 'internal', message: 'Internal error.', requestId: '2b7fd2e0-b9e1-4d3d' })
  assert.match(text, /nothing was changed/)
  assert.match(text, /reference 2b7fd2e0\)/)
  assert.match(text, /tell the people who run this server/)
  assert.doesNotMatch(text, /Internal error/)
})

test('generic refusals get plain wording; specific ones are kept', () => {
  assert.match(friendlyError({ status: 401, code: 'unauthorized', message: 'Not authenticated.' }), /Sign in again/)
  assert.match(friendlyError({ status: 403, code: 'forbidden', message: 'Not permitted.' }), /Ask an admin/)
  assert.match(friendlyError({ status: 404, code: 'not_found', message: 'Not found.' }), /deleted on another device/)
  assert.equal(friendlyError({ status: 400, code: 'bad_request', message: 'schedule.hour must be a whole number from 0 to 23.' }), 'schedule.hour must be a whole number from 0 to 23.')
  assert.equal(friendlyError({ status: 409, code: 'conflict', message: 'That image is in use.' }), 'That image is in use.')
  assert.equal(friendlyError({ status: 403, code: 'forbidden', message: 'An account could not be created with these details.' }), 'An account could not be created with these details.')
})
