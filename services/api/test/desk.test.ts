// The service desk: public requests, support tickets, the staff queue, the
// two one-click actions, privacy of addresses, and who may do what.

import test from 'node:test'
import assert from 'node:assert/strict'

import { emailDigest } from '../src/identity.js'
import { closeStaleTickets } from '../src/routes/desk.js'
import { fixtureB64, harness, registration } from './harness.js'

type H = ReturnType<typeof harness>

async function staff(h: H) {
  h.app.adminDigests = new Set([emailDigest('boss@example.test', h.app.config.pepper)])
  const boss = await h.request('POST', '/api/auth/register', { body: registration({ email: 'boss@example.test' }) })
  return String(boss.body['accessToken'])
}

async function user(h: H, email = 'member@example.test') {
  const res = await h.request('POST', '/api/auth/register', { body: registration({ email }) })
  return { token: String(res.body['accessToken']), userId: String(res.body['userId']) }
}

test('a public access request opens a ticket, confirms by email, and says nothing about accounts', async () => {
  const h = harness({ mail: true })
  const owner = await staff(h)
  const res = await h.request('POST', '/api/desk/requests', { body: { kind: 'access', name: 'Riya', email: 'riya@example.test', message: 'From finance' } })
  assert.equal(res.status, 201)
  assert.equal(res.body['number'], 1)
  assert.match(h.outbox.at(-1)!.subject, /\[Vault #1\] We received/)

  // The same answer for an address that has an account.
  const known = await h.request('POST', '/api/desk/requests', { body: { kind: 'signin', name: 'Boss', email: 'boss@example.test' } })
  assert.equal(known.status, 201)
  assert.deepEqual(Object.keys(known.body), ['number'])

  const q = await h.request('GET', '/api/admin/desk', { token: owner })
  const tickets = q.body['tickets'] as { kind: string; priority: string; requester: { email: string } }[]
  assert.equal(tickets.length, 2)
  assert.equal(tickets.find((t) => t.kind === 'signin')!.priority, 'high')
  assert.equal(tickets.find((t) => t.kind === 'access')!.requester.email, 'riya@example.test')
})

test('public requests are rate-limited', async () => {
  const h = harness()
  let limited = 0
  for (let i = 0; i < 8; i++) {
    const r = await h.request('POST', '/api/desk/requests', { body: { kind: 'access', name: 'Spam', email: `s${i}@example.test` } })
    if (r.status === 429) limited++
  }
  assert.ok(limited > 0)
})

test('approving an access request issues an invitation, emails it, and resolves the ticket', async () => {
  const h = harness({ mail: true })
  const owner = await staff(h)
  await h.request('POST', '/api/desk/requests', { body: { kind: 'access', name: 'Riya', email: 'riya@example.test' } })
  const id = ((await h.request('GET', '/api/admin/desk', { token: owner })).body['tickets'] as { id: string }[])[0]!.id
  const res = await h.request('POST', `/api/admin/desk/${id}/approve`, { token: owner, body: {} })
  assert.equal(res.status, 200)
  assert.equal(res.body['emailed'], true)
  assert.equal((res.body['ticket'] as { status: string }).status, 'resolved')
  const invite = h.outbox.find((m) => m.to === 'riya@example.test' && m.text.includes('/app/?invite='))!
  assert.ok(invite.text.includes(String(res.body['code'])))
  // The invitation works.
  h.app.allowRegistration = false
  await h.request('PUT', '/api/admin/settings', { token: owner, body: { registration: 'invite' } })
  assert.equal((await h.request('POST', '/api/auth/register', { body: registration({ email: 'riya@example.test', inviteCode: res.body['code'] }) })).status, 201)
})

test('a verified sign-in request can have two-factor reset, by users.write only', async () => {
  const h = harness()
  const owner = await staff(h)
  const member = await user(h)
  h.app.adminDigests = new Set([...h.app.adminDigests])
  await h.store.put({ ...(await h.store.get(`USER#${member.userId}`, 'PROFILE'))!, totp: 'sealed-secret', recoveryCodes: ['x'] })
  await h.request('POST', '/api/desk/requests', { body: { kind: 'signin', name: 'Member', email: 'member@example.test', message: 'New phone' } })
  const id = ((await h.request('GET', '/api/admin/desk', { token: owner })).body['tickets'] as { id: string }[])[0]!.id

  // A support agent cannot; an owner can.
  const agent = await user(h, 'agent@example.test')
  await h.request('PUT', `/api/admin/users/${agent.userId}/role`, { token: owner, body: { role: 'support' } })
  assert.equal((await h.request('POST', `/api/admin/desk/${id}/reset-2fa`, { token: agent.token })).status, 403)
  const res = await h.request('POST', `/api/admin/desk/${id}/reset-2fa`, { token: owner })
  assert.equal(res.status, 200)
  assert.equal(res.body['hadTwoFactor'], true)
  assert.equal((await h.store.get(`USER#${member.userId}`, 'PROFILE'))!['totp'], undefined)
})

test('support tickets: a user opens, staff reply, the user replies, and nobody else can see it', async () => {
  const h = harness({ mail: true })
  const owner = await staff(h)
  const member = await user(h)
  const created = await h.request('POST', '/api/desk/tickets', { token: member.token, body: { subject: 'Import failed', category: 'problem', message: 'My CSV from Zoho', email: 'member@example.test' } })
  assert.equal(created.status, 201)
  const id = (created.body['ticket'] as { id: string }).id

  await h.request('POST', `/api/admin/desk/${id}/messages`, { token: owner, body: { body: 'Checking the user', internal: true } })
  await h.request('POST', `/api/admin/desk/${id}/messages`, { token: owner, body: { body: 'Which columns does it have?' } })
  assert.equal(h.outbox.at(-1)!.to, 'member@example.test', 'the reply is emailed')

  const mine = await h.request('GET', `/api/desk/tickets/${id}`, { token: member.token })
  const msgs = mine.body['messages'] as { body: string; internal: boolean }[]
  assert.deepEqual(msgs.map((m) => m.body), ['My CSV from Zoho', 'Which columns does it have?'], 'internal notes are hidden from the requester')
  assert.equal((mine.body['ticket'] as { status: string }).status, 'waiting')

  const reply = await h.request('POST', `/api/desk/tickets/${id}/messages`, { token: member.token, body: { body: 'Password Name, SecretData' } })
  assert.equal((reply.body['ticket'] as { status: string }).status, 'open', 'a reply puts it back with staff')

  const other = await user(h, 'other@example.test')
  assert.equal((await h.request('GET', `/api/desk/tickets/${id}`, { token: other.token })).status, 404)
  assert.equal((await h.request('GET', '/api/admin/desk', { token: member.token })).status, 403)
  assert.equal(((await h.request('GET', '/api/desk/tickets', { token: member.token })).body['tickets'] as unknown[]).length, 1)
})

test('closing erases the requester address; resolved tickets close themselves after a week', async () => {
  const h = harness()
  const owner = await staff(h)
  await h.request('POST', '/api/desk/requests', { body: { kind: 'access', name: 'Riya', email: 'riya@example.test' } })
  const id = ((await h.request('GET', '/api/admin/desk', { token: owner })).body['tickets'] as { id: string }[])[0]!.id
  await h.request('PUT', `/api/admin/desk/${id}`, { token: owner, body: { status: 'resolved' } })
  assert.ok(JSON.stringify(h.store.dump()).includes('riya@example.test'))
  h.setNow(h.app.now() + 8 * 86_400_000)
  assert.equal(await closeStaleTickets(h.app), 1)
  assert.equal(JSON.stringify(h.store.dump()).includes('riya@example.test'), false, 'the address is gone from the table')
  // (The clock moved a week, so read the row directly rather than with an expired token.)
  const t = (await h.store.get('DESK', `TICKET#${id}`))! as unknown as { status: string; requester: { emailErased: boolean } }
  assert.equal(t.status, 'closed')
  assert.equal(t.requester.emailErased, true)
})

test('the overview counts open tickets, and a support agent sees only the desk and invitations', async () => {
  const h = harness()
  const owner = await staff(h)
  await h.request('POST', '/api/desk/requests', { body: { kind: 'access', name: 'A', email: 'a@example.test' } })
  assert.equal((await h.request('GET', '/api/admin/overview', { token: owner })).body['openTickets'], 1)
  const agent = await user(h, 'agent@example.test')
  await h.request('PUT', `/api/admin/users/${agent.userId}/role`, { token: owner, body: { role: 'support' } })
  assert.equal((await h.request('GET', '/api/admin/desk', { token: agent.token })).status, 200)
  assert.equal((await h.request('GET', '/api/admin/users', { token: agent.token })).status, 403)
  const me = await h.request('GET', '/api/auth/me', { token: agent.token })
  assert.deepEqual(me.body['permissions'], ['desk.read', 'desk.write', 'invites.read', 'invites.write'])
  void fixtureB64
})
