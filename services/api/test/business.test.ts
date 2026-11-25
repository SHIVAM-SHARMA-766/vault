// The business edition (decisions/0032, stage 2a): one company per server,
// one invitation for someone without an account, and Add to company for an
// account the admin already sees.

import test from 'node:test'
import assert from 'node:assert/strict'

import { generateIdentityKeyPair, generateOrgKey, sealOrgKey, sealOrgMeta, toBase64Url } from '@vault/crypto'

import { fixtureB64, harness, registration, sealedBlob } from './harness.js'

const OWNER = 'owner@example.com'

async function setup(edition: 'business' | 'hosted') {
  const h = harness({ edition, adminEmails: [OWNER], allowRegistration: true })
  const keys = await generateIdentityKeyPair()
  const token = String((await h.request('POST', '/api/auth/register', {
    body: registration({ email: OWNER, authKey: fixtureB64('owner'), identity: { publicKey: toBase64Url(keys.publicKey), wrappedPrivateKey: sealedBlob('owner-pk', 160) } }),
  })).body['accessToken'])
  const orgKey = generateOrgKey()
  const org = async (id: string) => ({ id, hint: 'Acme', label: 'owner', nameBlob: await sealOrgMeta(id, { name: 'Acme' }, orgKey), orgKeyBlob: await sealOrgKey(keys.publicKey, orgKey, id) })
  return { h, token, org }
}

test('a business Vault has one company; direct shares and hosted servers are not limited', async () => {
  const { h, token, org } = await setup('business')
  assert.equal((await h.request('POST', '/api/orgs', { token, body: await org(crypto.randomUUID()) })).status, 201)
  const second = await h.request('POST', '/api/orgs', { token, body: await org(crypto.randomUUID()) })
  assert.equal(second.status, 409)
  assert.match(String(second.body['message']), /one company/)
  assert.equal((await h.request('POST', '/api/orgs', { token, body: { ...(await org(crypto.randomUUID())), kind: 'direct' } })).status, 201)

  const hosted = await setup('hosted')
  assert.equal((await hosted.h.request('POST', '/api/orgs', { token: hosted.token, body: await hosted.org(crypto.randomUUID()) })).status, 201)
  assert.equal((await hosted.h.request('POST', '/api/orgs', { token: hosted.token, body: await hosted.org(crypto.randomUUID()) })).status, 201)
})

test('inviting an address without an account gives a sign-up code, in business only', async () => {
  const { h, token, org } = await setup('business')
  const id = crypto.randomUUID()
  await h.request('POST', '/api/orgs', { token, body: await org(id) })
  const res = await h.request('POST', `/api/orgs/${id}/invites`, { token, body: { email: 'newcomer@example.com', label: 'Newcomer', withSignup: true } })
  assert.equal(res.status, 201)
  const signup = res.body['signup'] as { code: string; emailed: boolean }
  assert.match(signup.code, /\w{4}/)
  assert.equal(signup.emailed, false, 'no mail on this server')

  // The code works, and the invitation is waiting for the new account.
  const reg = await h.request('POST', '/api/auth/register', { body: registration({ email: 'newcomer@example.com', authKey: fixtureB64('newcomer'), inviteCode: signup.code }) })
  assert.equal(reg.status, 201)
  const invitations = (await h.request('GET', '/api/orgs/invitations', { token: String(reg.body['accessToken']) })).body['invitations'] as { orgId: string }[]
  assert.deepEqual(invitations.map((i) => i.orgId), [id])

  // An address that has an account gets no code; neither does any address on a hosted server.
  const again = await h.request('POST', `/api/orgs/${id}/invites`, { token, body: { email: 'newcomer@example.com', withSignup: true } })
  assert.equal(again.body['signup'], undefined)
  const hosted = await setup('hosted')
  const hid = crypto.randomUUID()
  await hosted.h.request('POST', '/api/orgs', { token: hosted.token, body: await hosted.org(hid) })
  const h2 = await hosted.h.request('POST', `/api/orgs/${hid}/invites`, { token: hosted.token, body: { email: 'someone@example.com', withSignup: true } })
  assert.equal(h2.status, 201)
  // A hosted server (EDITION=hosted) gives a code for any address, so nothing is learnt (0033).
  assert.ok((h2.body['signup'] as { code?: string } | undefined)?.code)
})

test('Add to company invites an existing account by its id, for admins who see accounts', async () => {
  const { h, token, org } = await setup('business')
  const id = crypto.randomUUID()
  await h.request('POST', '/api/orgs', { token, body: await org(id) })
  const bobToken = String((await h.request('POST', '/api/auth/register', { body: registration({ email: 'bob@example.com', authKey: fixtureB64('bob') }) })).body['accessToken'])
  const bobId = String((await h.request('GET', '/api/auth/me', { token: bobToken })).body['userId'])
  await h.request('PUT', `/api/admin/users/${bobId}/label`, { token, body: { label: 'Bob' } })

  const res = await h.request('POST', `/api/orgs/${id}/invites`, { token, body: { userId: bobId } })
  assert.equal(res.status, 201)
  const invitations = (await h.request('GET', '/api/orgs/invitations', { token: bobToken })).body['invitations'] as { orgId: string }[]
  assert.deepEqual(invitations.map((i) => i.orgId), [id])
  const pending = (await h.request('GET', `/api/orgs/${id}/members`, { token })).body['pending'] as { label: string }[]
  assert.deepEqual(pending.map((p) => p.label), ['Bob'], 'labelled as the server labels the account')

  assert.equal((await h.request('POST', `/api/orgs/${id}/invites`, { token, body: { userId: crypto.randomUUID() } })).status, 404)
})
