// Hosted tenants run by the operator (admin console phase 4): seat limits,
// suspend and resume, and verified domains.

import test from 'node:test'
import assert from 'node:assert/strict'

import { generateIdentityKeyPair, generateOrgKey, sealOrgKey, sealOrgMeta, toBase64Url } from '@vault/crypto'

import { setTxtResolver } from '../src/routes/tenants.js'
import { fixtureB64, harness, registration, sealedBlob } from './harness.js'

const OWNER = 'owner@example.com'

async function setup() {
  const h = harness({ edition: 'hosted', adminEmails: [OWNER], allowRegistration: true, mail: true })
  const keys = await generateIdentityKeyPair()
  const token = String((await h.request('POST', '/api/auth/register', {
    ip: '198.51.100.1',
    body: registration({ email: OWNER, authKey: fixtureB64('owner'), identity: { publicKey: toBase64Url(keys.publicKey), wrappedPrivateKey: sealedBlob('owner-pk', 160) } }),
  })).body['accessToken'])
  const orgKey = generateOrgKey()
  const id = crypto.randomUUID()
  assert.equal((await h.request('POST', '/api/orgs', { token, body: { id, hint: 'Acme', label: 'owner', nameBlob: await sealOrgMeta(id, { name: 'Acme' }, orgKey), orgKeyBlob: await sealOrgKey(keys.publicKey, orgKey, id) } })).status, 201)
  return { h, token, id }
}

test('a seat limit stops new invitations once reached; inviting again keeps a seat', async () => {
  const { h, token, id } = await setup()
  assert.equal((await h.request('PUT', `/api/admin/orgs/${id}`, { token, body: { seatLimit: 2 } })).status, 200)
  assert.equal((await h.request('POST', `/api/orgs/${id}/invites`, { token, body: { email: 'a@example.com' } })).status, 201)
  assert.equal((await h.request('POST', `/api/orgs/${id}/invites`, { token, body: { email: 'a@example.com', label: 'Asha' } })).status, 201, 'the same person again')
  const full = await h.request('POST', `/api/orgs/${id}/invites`, { token, body: { email: 'b@example.com' } })
  assert.equal(full.status, 409)
  assert.match(String(full.body['message']), /all 2 of its seats/)
  const detail = (await h.request('GET', `/api/admin/orgs/${id}`, { token })).body
  assert.deepEqual([detail['seatsUsed'], detail['seatLimit']], [2, 2])
  assert.equal((await h.request('PUT', `/api/admin/orgs/${id}`, { token, body: { seatLimit: null } })).status, 200)
  assert.equal((await h.request('POST', `/api/orgs/${id}/invites`, { token, body: { email: 'b@example.com' } })).status, 201)
  assert.equal((await h.request('PUT', `/api/admin/orgs/${id}`, { token, body: { seatLimit: 0 } })).status, 400)
})

test('a suspended company refuses its members, who keep their own vault; resuming restores it', async () => {
  const { h, token, id } = await setup()
  assert.equal((await h.request('PUT', `/api/admin/orgs/${id}`, { token, body: { suspended: true } })).status, 200)
  const refused = await h.request('GET', `/api/orgs/${id}/members`, { token })
  assert.equal(refused.status, 403)
  assert.match(String(refused.body['message']), /suspended/)
  const mine = (await h.request('GET', '/api/orgs', { token })).body['orgs'] as { id: string; suspended?: boolean }[]
  assert.equal(mine.find((o) => o.id === id)!.suspended, true)
  assert.equal((await h.request('GET', '/api/vault', { token })).status, 200)
  const list = (await h.request('GET', '/api/admin/orgs', { token })).body['orgs'] as { id: string; suspended: boolean }[]
  assert.equal(list.find((o) => o.id === id)!.suspended, true)
  assert.equal((await h.request('PUT', `/api/admin/orgs/${id}`, { token, body: { suspended: false } })).status, 200)
  assert.equal((await h.request('GET', `/api/orgs/${id}/members`, { token })).status, 200)
  const audit = (await h.request('GET', '/api/admin/audit?action=org.', { token })).body['records'] as { action: string }[]
  assert.deepEqual(audit.map((r) => r.action).sort(), ['org.resume', 'org.suspend'])
})

test('a domain is claimed, verified by its DNS record, and then approves vault requests at once', async () => {
  const { h, token, id } = await setup()
  const claim = await h.request('POST', `/api/admin/orgs/${id}/domains`, { token, body: { domain: 'Acme.Example' } })
  assert.equal(claim.status, 201)
  const record = claim.body['record'] as { name: string; value: string }
  assert.equal(record.name, '_vault-verify.acme.example')
  assert.match(record.value, /^vault-verify=[0-9a-f]{32}$/)
  assert.equal((await h.request('POST', `/api/admin/orgs/${id}/domains`, { token, body: { domain: 'not a domain' } })).status, 400)

  // Not in DNS yet.
  setTxtResolver(async () => { throw new Error('ENOTFOUND') })
  const early = await h.request('POST', `/api/admin/orgs/${id}/domains/acme.example/verify`, { token })
  assert.equal(early.status, 400)
  assert.match(String(early.body['message']), /No TXT record/)
  // There now.
  setTxtResolver(async (name) => (name === record.name ? [['v=spf1 -all'], [record.value]] : []))
  const ok = await h.request('POST', `/api/admin/orgs/${id}/domains/acme.example/verify`, { token })
  assert.equal(ok.status, 200)
  assert.ok((ok.body['domain'] as { verifiedAt?: string }).verifiedAt)

  // Someone at the domain signs up and asks for a vault: approved at once.
  h.app.allowRegistration = false
  await h.request('PUT', '/api/admin/settings', { token, body: { registration: 'invite' } })
  assert.equal((await h.request('POST', '/api/auth/account/signup', { ip: '198.51.100.40', body: { email: 'asha@acme.example' } })).status, 200)
  await new Promise((r) => setTimeout(r, 10))
  const code = /\b(\d{6})\b/.exec(h.outbox.filter((m) => m.to === 'asha@acme.example').at(-1)!.text)![1]!
  const acct = (await h.request('POST', '/api/auth/account/signup/verify', { ip: '198.51.100.41', body: { email: 'asha@acme.example', code, account: { salt: fixtureB64('s', 16), m: 19_456, t: 2, p: 1, proof: fixtureB64('p') } } })).body
  const asked = await h.request('POST', '/api/auth/vault/request', { body: { accountToken: acct['accountToken'] } })
  assert.equal(asked.body['approved'], true)
  assert.equal(((await h.request('GET', '/api/admin/vault-requests', { token })).body['requests'] as unknown[]).length, 0, 'nothing for the operator to do')

  // Released, it no longer does.
  assert.equal((await h.request('DELETE', `/api/admin/orgs/${id}/domains/acme.example`, { token })).status, 200)
  setTxtResolver(async () => [])
})
