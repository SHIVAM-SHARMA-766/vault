// Item templates: tidied on read, and applied to a draft without losing what
// was typed.

import test from 'node:test'
import assert from 'node:assert/strict'

import { TEMPLATES_MAX, applyTemplate, normalizePrefs, normalizeTemplates } from '../src/index.js'

test('only well-formed templates are kept, tidied', () => {
  const t = normalizeTemplates([
    { id: 'laptop', name: '  Office laptop ', base: 'note', fields: [{ label: 'Serial', hidden: false }, { label: 'serial' }, { label: 'BIOS password', hidden: true }, { label: '' }, 5] },
    { id: 'laptop', name: 'Duplicate id' },
    { id: 'bad id!', name: 'x' },
    { id: 'nameless', name: '' },
    { id: 'weird', name: 'Weird base', base: 'spaceship' },
    null, 'str',
  ])
  assert.deepEqual(t, [
    { id: 'laptop', name: 'Office laptop', base: 'note', fields: [{ label: 'Serial', hidden: false }, { label: 'BIOS password', hidden: true }] },
    { id: 'weird', name: 'Weird base', base: 'login', fields: [] },
  ])
  assert.equal(normalizeTemplates(Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, name: `T${i}` }))).length, TEMPLATES_MAX)
  assert.deepEqual(normalizeTemplates('nope'), [])
  assert.deepEqual(normalizePrefs({}).templates, [])
})

test('applying a template sets the type and fields, keeping typed values and extra fields', () => {
  const tpl = { id: 'laptop', name: 'Office laptop', base: 'note', fields: [{ label: 'Serial', hidden: false }, { label: 'BIOS password', hidden: true }] }
  const draft = { type: 'login', name: 'X1', customFields: [{ label: 'serial', value: 'PF-123', hidden: false }, { label: 'Owner', value: 'Ravi', hidden: false }, { label: '', value: '', hidden: false }] }
  const next = applyTemplate(draft, tpl)
  assert.equal(next.type, 'note')
  assert.equal(next.template, 'laptop')
  assert.equal(next.name, 'X1')
  assert.deepEqual(next.customFields, [
    { label: 'Serial', value: 'PF-123', hidden: false },
    { label: 'BIOS password', value: '', hidden: true },
    { label: 'Owner', value: 'Ravi', hidden: false },
  ])
})
