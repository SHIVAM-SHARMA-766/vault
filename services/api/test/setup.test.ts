// First-run setup: a fresh server issues a one-time code that creates the
// owner, even with registration closed, and never again once anyone exists.

import test from 'node:test'
import assert from 'node:assert/strict'

import { ensureSetup, listInvites } from '../src/system.js'
import { harness, registration } from './harness.js'

test('a fresh server issues a code that creates the owner while registration is closed', async () => {
  const h = harness({ allowRegistration: false })
  const code = await ensureSetup(h.app)
  assert.ok(code)
  // Without the code: closed.
  assert.equal((await h.request('POST', '/api/auth/register', { body: registration({ email: 'x@example.test' }) })).status, 403)
  const res = await h.request('POST', '/api/auth/register', { body: registration({ email: 'owner@example.test', inviteCode: code }) })
  assert.equal(res.status, 201)
  const me = await h.request('GET', '/api/auth/me', { token: String(res.body['accessToken']) })
  assert.equal(me.body['role'], 'owner')
  assert.equal(me.body['isAdmin'], true)
  // Used up, and no new one is issued now that an account exists.
  assert.equal((await h.request('POST', '/api/auth/register', { body: registration({ email: 'y@example.test', inviteCode: code }) })).status, 403)
  assert.equal(await ensureSetup(h.app), null)
})

test('a restart replaces an unused code; only the newest works', async () => {
  const h = harness({ allowRegistration: false })
  const first = await ensureSetup(h.app)
  const second = await ensureSetup(h.app)
  assert.notEqual(first, second)
  assert.equal((await listInvites(h.app)).filter((i) => i.setup).length, 1)
  assert.equal((await h.request('POST', '/api/auth/register', { body: registration({ email: 'a@example.test', inviteCode: first }) })).status, 403)
  assert.equal((await h.request('POST', '/api/auth/register', { body: registration({ email: 'a@example.test', inviteCode: second }) })).status, 201)
})

test('no code when ADMIN_EMAILS names the owner, or once any account exists', async () => {
  assert.equal(await ensureSetup(harness({ adminEmails: ['boss@example.test'] }).app), null)
  const h = harness({ allowRegistration: true })
  await h.request('POST', '/api/auth/register', { body: registration() })
  assert.equal(await ensureSetup(h.app), null)
})

test('a setup code cannot make a second owner after someone else registered first', async () => {
  const h = harness({ allowRegistration: true })
  const code = await ensureSetup(h.app)
  await h.request('POST', '/api/auth/register', { body: registration({ email: 'early@example.test' }) })
  const res = await h.request('POST', '/api/auth/register', { body: registration({ email: 'late@example.test', inviteCode: code }) })
  assert.equal(res.status, 403)
})

test('nobody can invite an owner', async () => {
  const h = harness({ adminEmails: ['boss@example.test'] })
  h.app.allowRegistration = true
  const boss = await h.request('POST', '/api/auth/register', { body: registration({ email: 'boss@example.test' }) })
  const res = await h.request('POST', '/api/admin/invites', { token: String(boss.body['accessToken']), body: { label: 'x', role: 'owner' } })
  assert.equal(res.status, 400)
})
