// The hosted edition (decisions/0033): companies are invited by the operator.
// A plain account cannot create one; a company invitation lets its holder
// create exactly one; a tenant's admin gets a sign-up code for any address, so
// it reveals nothing about accounts in other tenants.

import test from 'node:test'
import assert from 'node:assert/strict'

import { generateIdentityKeyPair, generateOrgKey, sealOrgKey, sealOrgMeta, toBase64Url } from '@vault/crypto'

import { harness, registration, sealedBlob } from './harness.js'

type H = ReturnType<typeof harness>
const OWNER = 'operator@example.com'

async function person(h: H, email: string, inviteCode?: string) {
  const keys = await generateIdentityKeyPair()
  const res = await h.request('POST', '/api/auth/register', { body: registration({ email, ...(inviteCode ? { inviteCode } : {}), identity: { publicKey: toBase64Url(keys.publicKey), wrappedPrivateKey: sealedBlob(`${email}-pk`, 160) } }) })
  assert.equal(res.status, 201, JSON.stringify(res.body))
  const token = String(res.body['accessToken'])
  const orgKey = generateOrgKey()
  const company = async (kind?: 'direct') => {
    const id = crypto.randomUUID()
    const r = await h.request('POST', '/api/orgs', { token, body: { id, hint: 'Co', label: email, nameBlob: await sealOrgMeta(id, { name: 'Co' }, orgKey), orgKeyBlob: await sealOrgKey(keys.publicKey, orgKey, id), ...(kind ? { kind } : {}) } })
    return { status: r.status, id, message: String(r.body['message'] ?? '') }
  }
  const canCreate = async () => (await h.request('GET', '/api/auth/me', { token })).body['canCreateCompany']
  return { token, company, canCreate }
}

test('on a hosted server a plain account cannot create a company; the operator can', async () => {
  const h = harness({ edition: 'hosted', adminEmails: [OWNER], allowRegistration: true })
  const operator = await person(h, OWNER)
  const priya = await person(h, 'priya@example.com')
  assert.equal(await priya.canCreate(), false)
  const refused = await priya.company()
  assert.equal(refused.status, 403)
  assert.match(refused.message, /invited by its operator/)
  assert.equal((await priya.company('direct')).status, 201, 'sharing with one person still works')
  assert.equal(await operator.canCreate(), true)
  assert.equal((await operator.company()).status, 201)
})

test('a company invitation lets its holder create one company, once', async () => {
  // Registration open: the company invitation is still claimed, so its grant is not lost.
  const h = harness({ edition: 'hosted', adminEmails: [OWNER], allowRegistration: true })
  const operator = await person(h, OWNER)
  const inv = await h.request('POST', '/api/admin/company-invites', { token: operator.token, body: { label: 'Acme Corp' } })
  assert.equal(inv.status, 201)
  const anita = await person(h, 'anita@acme.example', String(inv.body['code']))
  assert.equal(await anita.canCreate(), true)
  const made = await anita.company()
  assert.equal(made.status, 201)
  assert.equal(await anita.canCreate(), false, 'used up')
  assert.equal((await anita.company()).status, 403)
  const list = (await h.request('GET', '/api/admin/invites', { token: operator.token })).body['invites'] as { company?: boolean }[]
  assert.ok(list.some((i) => i.company), 'listed as a company invitation')

  // A tenant admin's invitation always carries a sign-up code: an address with
  // an account gets one too, so nothing is learnt about other tenants.
  const outsider = await person(h, OWNER.replace('operator', 'other'))
  void outsider
  for (const email of ['new@acme.example', 'other@example.com']) {
    const r = await h.request('POST', `/api/orgs/${made.id}/invites`, { token: anita.token, body: { email, withSignup: true } })
    assert.equal(r.status, 201)
    assert.ok((r.body['signup'] as { code?: string } | undefined)?.code, email)
  }
})

test('company invitations exist only on a hosted server', async () => {
  for (const edition of ['business', 'personal'] as const) {
    const h = harness({ edition, adminEmails: [OWNER], allowRegistration: true })
    const operator = await person(h, OWNER)
    assert.equal((await h.request('POST', '/api/admin/company-invites', { token: operator.token, body: { label: 'X' } })).status, 404, edition)
  }
})
