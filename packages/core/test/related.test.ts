// Related items read both ways, once each, and ignore what is gone.

import test from 'node:test'
import assert from 'node:assert/strict'

import { RELATED_MAX, cleanRelated, relatedItems } from '../src/index.js'

const items = [
  { id: 'server', related: ['key', 'gone', 'server'] },
  { id: 'key' },
  { id: 'db', related: ['server'] },
  { id: 'old', related: ['server'], archived: true },
  { id: 'other' },
]

test('links read both ways, each item once, missing and archived ones left out', () => {
  assert.deepEqual(relatedItems('server', items).map((e) => e.id), ['key', 'db'])
  assert.deepEqual(relatedItems('key', items).map((e) => e.id), ['server'], 'a backlink')
  assert.deepEqual(relatedItems('server', items, { archived: true }).map((e) => e.id), ['key', 'db', 'old'])
  assert.deepEqual(relatedItems('other', items), [])
  assert.deepEqual(relatedItems('nope', items), [])
})

test('the saved list is tidy', () => {
  assert.deepEqual(cleanRelated('a', ['b', 'a', 'b', '', 3, 'c']), ['b', 'c'])
  assert.equal(cleanRelated('a', Array.from({ length: 50 }, (_, i) => `x${i}`)).length, RELATED_MAX)
  assert.deepEqual(cleanRelated(undefined, undefined), [])
})
