// Editions (decisions/0030): one codebase, three servers. A personal Vault has
// one account and none of the features that need a second; a business Vault
// has everything but the website editor; hosted has everything. A feature that
// is off is refused by the server, not only hidden.

import test from 'node:test'
import assert from 'node:assert/strict'

import { fixtureB64, harness, registration, sealedBlob } from './harness.js'

const OWNER = 'owner@example.com'

async function setup(edition: 'personal' | 'business' | 'hosted') {
  const h = harness({ edition, adminEmails: [OWNER], allowRegistration: true })
  const token = String((await h.request('POST', '/api/auth/register', { body: registration({ email: OWNER, authKey: fixtureB64('owner') }) })).body['accessToken'])
  return { h, token }
}

test('the instance says which edition and features a server has; hosted is the default', async () => {
  const plain = harness()
  const hosted = (await plain.request('GET', '/api/instance')).body
  assert.equal(hosted['edition'], 'hosted')
  assert.deepEqual(hosted['features'], { organizations: true, invitations: true, serviceDesk: true, website: true, staffRoles: true, emergencyAccess: true })

  const { h: ph } = await setup('personal')
  const personal = (await ph.request('GET', '/api/instance')).body
  assert.equal(personal['edition'], 'personal')
  assert.equal(personal['registration'], 'closed', 'closed once the owner exists, whatever the host forces')
  assert.deepEqual(personal['features'], { organizations: false, invitations: false, serviceDesk: false, website: false, staffRoles: false, emergencyAccess: false })

  const business = (await harness({ edition: 'business' }).request('GET', '/api/instance')).body
  assert.equal((business['features'] as Record<string, boolean>)['website'], false)
  assert.equal((business['features'] as Record<string, boolean>)['organizations'], true)
})

test('a personal Vault has one account: nobody else can join, even with registration forced open', async () => {
  const { h, token } = await setup('personal')
  const second = await h.request('POST', '/api/auth/register', { body: registration({ email: 'someone@example.com', authKey: fixtureB64('someone') }) })
  assert.equal(second.status, 403)
  assert.match(String(second.body['message']), /personal Vault/)
  const change = await h.request('PUT', '/api/admin/settings', { token, body: { registration: 'open' } })
  assert.equal(change.status, 400)
})

test('a personal Vault refuses what needs a second person, and keeps everything else', async () => {
  const { h, token } = await setup('personal')
  const me = String((await h.request('GET', '/api/auth/me', { token })).body['userId'])
  for (const [method, path] of [
    ['GET', '/api/orgs'], ['POST', '/api/orgs'], ['GET', '/api/admin/orgs'],
    ['GET', '/api/admin/invites'], ['POST', '/api/admin/invites'],
    ['GET', '/api/admin/desk'], ['POST', '/api/desk/requests'],
    ['GET', '/api/admin/site/pages'], ['PUT', `/api/admin/users/${me}/role`],
    ['GET', '/api/emergency'], ['GET', '/api/emergency/trusted'],
  ] as const) {
    const res = await h.request(method, path, { token, body: {} })
    assert.equal(res.status, 404, `${method} ${path}`)
    assert.equal(res.body['error'], 'not_in_edition', `${method} ${path}`)
  }
  // The vault, settings and share links are all there.
  assert.ok((await h.request('PUT', `/api/vault/entries/${crypto.randomUUID()}`, { token, body: { blob: sealedBlob('e1') } })).status < 300)
  assert.equal((await h.request('GET', '/api/vault', { token })).status, 200)
  assert.equal((await h.request('GET', '/api/shares', { token })).status, 200)
  assert.equal((await h.request('GET', '/api/admin/settings', { token })).status, 200)
})

test('a business Vault has organizations and the desk, not the website editor', async () => {
  const { h, token } = await setup('business')
  assert.equal((await h.request('GET', '/api/orgs', { token })).status, 200)
  assert.equal((await h.request('GET', '/api/admin/desk', { token })).status, 200)
  const site = await h.request('GET', '/api/admin/site/pages', { token })
  assert.equal(site.status, 404)
  assert.equal(site.body['error'], 'not_in_edition')
})

test('the host can turn off two-factor sign-in for an address, audited', async () => {
  const { resetTwoFactorFromHost } = await import('../src/routes/admin.js')
  const { h, token } = await setup('personal')
  const me = String((await h.request('GET', '/api/auth/me', { token })).body['userId'])
  const profile = h.store.dump().find((i) => i.pk === `USER#${me}` && i.sk === 'PROFILE')!
  await h.store.put({ ...profile, totp: { secret: 'x' }, recoveryCodes: ['a'] })
  assert.equal(await resetTwoFactorFromHost(h.app, OWNER.toUpperCase()), me)
  const after = h.store.dump().find((i) => i.pk === `USER#${me}` && i.sk === 'PROFILE')!
  assert.equal(after['totp'], undefined)
  assert.equal(after['recoveryCodes'], undefined)
  const log = h.store.dump().filter((i) => i['action'] === 'user.reset-2fa')
  assert.equal(log.length, 1)
  assert.equal(log[0]!['actor'], 'host')
  await assert.rejects(resetTwoFactorFromHost(h.app, 'nobody@example.com'), /no account/)
})

test('a server is refused a smaller edition than the data it holds', async () => {
  const { checkEditionFits } = await import('../src/edition.js')
  const { h } = await setup('hosted')
  await h.request('POST', '/api/auth/register', { body: registration({ email: 'second@example.com', authKey: fixtureB64('second') }) })
  await assert.doesNotReject(checkEditionFits(h.app))
  h.app.config.edition = 'personal'
  await assert.rejects(checkEditionFits(h.app), /EDITION=personal/)
  h.app.config.edition = 'business'
  await assert.doesNotReject(checkEditionFits(h.app), 'moving up is always allowed')
})
