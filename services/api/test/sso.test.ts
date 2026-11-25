// Single sign-on (decisions/0021, option 1) against a mock OpenID Connect
// provider: the full round trip, every ID-token check, tickets used once and
// only for their account, the master password still required, "require SSO"
// on every sign-in path with the owner exempt, and provisioning.

import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { forgetOidcCaches } from '../src/oidc.js'
import { fixtureB64, harness, registration } from './harness.js'
import { type MockIdp, type Spoil, mockIdp } from './mock-idp.js'
import { SoftAuthenticator } from './soft-authenticator.js'

const POLICY = { requireTwoFactor: false, minPasswordScore: 0, maxIdleMinutes: null, sessionDays: null, activityDays: 90, auditDays: 365, shareLinks: true, shareLinkMaxDays: 30, allowedNetworks: [] as string[] }

let idps: MockIdp[] = []
afterEach(async () => { forgetOidcCaches(); await Promise.all(idps.map((i) => i.close())); idps = [] })

async function setup(opts: { provision?: boolean } = {}) {
  let now = Date.UTC(2026, 8, 22, 12, 0, 0)
  const idp = await mockIdp(() => now)
  idps.push(idp)
  const h = harness({ adminEmails: ['owner@example.com'], allowRegistration: true, oidc: { issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret, name: 'Okta', provision: opts.provision ?? false, requireVerifiedEmail: true } })
  const owner = String((await h.request('POST', '/api/auth/register', { body: registration({ email: 'owner@example.com', authKey: fixtureB64('owner') }) })).body['accessToken'])
  await h.request('POST', '/api/auth/register', { body: registration({ email: 'person@example.com' }) })
  h.app.allowRegistration = false
  const setNow = (ms: number) => { now = ms; h.setNow(ms) }
  return { h, idp, owner, setNow }
}

let host = 20
/** Runs the browser's part: start, the provider, the callback. Returns the fragment. */
async function signInWithIdp(h: ReturnType<typeof harness>, idp: MockIdp, email = 'person@example.com', spoil: Spoil = 'none', es256 = false): Promise<string> {
  idp.next = { email, spoil, es256 }
  const ip = `198.51.100.${host++}`
  const start = await h.request('GET', '/api/auth/sso/start', { ip })
  assert.equal(start.status, 302)
  const toIdp = new URL(start.headers['location']!)
  assert.equal(toIdp.searchParams.get('redirect_uri'), 'https://vault.test/api/auth/sso/callback')
  assert.equal(toIdp.searchParams.get('scope'), 'openid email profile')
  const fromIdp = await fetch(toIdp, { redirect: 'manual' })
  const cb = new URL(fromIdp.headers.get('location')!)
  const res = await h.request('GET', `/api/auth/sso/callback${cb.search}`, { ip })
  assert.equal(res.status, 302)
  const location = new URL(res.headers['location']!)
  assert.equal(`${location.origin}${location.pathname}`, 'https://vault.test/app/')
  return location.hash.slice(1)
}
const ticketOf = (fragment: string) => { assert.match(fragment, /^sso=/); return fragment.slice(4) }

const login = (h: ReturnType<typeof harness>, extra: Record<string, unknown> = {}, who = 'person@example.com', key = fixtureB64('auth-key')) =>
  h.request('POST', '/api/auth/login', { ip: `192.0.2.${host++ % 250}`, body: { email: who, authKey: key, ...extra } })

test('the round trip gives a ticket for the account; with the master password it signs in, once', async () => {
  const { h, idp } = await setup()
  const ticket = ticketOf(await signInWithIdp(h, idp))
  assert.deepEqual(idp.exchanges, [{ verifierOk: true, clientOk: true }], 'PKCE verifier and client secret sent')
  const info = await h.request('POST', '/api/auth/sso/ticket', { body: { ticket } })
  assert.deepEqual([info.body['email'], info.body['exists']], ['person@example.com', true])
  assert.ok(info.body['kdf'])
  // The ticket alone opens nothing: the master password is still checked.
  assert.equal((await login(h, { ssoTicket: ticket }, 'person@example.com', fixtureB64('wrong'))).status, 401)
  const ok = await login(h, { ssoTicket: ticket })
  assert.equal(ok.status, 200)
  assert.ok(ok.body['wrappedVaultKey'])
  const events = ((await h.request('GET', '/api/activity', { token: String(ok.body['accessToken']) })).body['events'] as { kind: string }[]).map((e) => e.kind)
  assert.ok(events.includes('sso-login'))
  assert.equal((await login(h, { ssoTicket: ticket })).body['error'], 'sso_invalid', 'used once')
})

test('a ticket is only for its own account, and expires', async () => {
  const { h, idp, setNow } = await setup()
  const ticket = ticketOf(await signInWithIdp(h, idp))
  assert.equal((await login(h, { ssoTicket: ticket }, 'owner@example.com', fixtureB64('owner'))).body['error'], 'sso_invalid')
  const later = ticketOf(await signInWithIdp(h, idp))
  setNow(Date.UTC(2026, 8, 22, 12, 6, 0))
  assert.equal((await login(h, { ssoTicket: later })).body['error'], 'sso_invalid', 'five minutes')
  assert.equal((await h.request('POST', '/api/auth/sso/ticket', { body: { ticket: later } })).status, 401)
})

test('every ID-token check refuses its spoiled token; ES256 and a replayed state too', async () => {
  const { h, idp } = await setup()
  const expected: Record<string, string> = {
    aud: 'bad_token', iss: 'bad_token', expired: 'bad_token', nonce: 'bad_token', signature: 'bad_token',
    'alg-none': 'bad_token', hs256: 'bad_token', unverified: 'unverified_email', 'no-email': 'no_email',
  }
  for (const [spoil, code] of Object.entries(expected)) {
    assert.equal(await signInWithIdp(h, idp, 'person@example.com', spoil as Spoil), `sso-error=${code}`, spoil)
  }
  assert.match(await signInWithIdp(h, idp, 'person@example.com', 'none', true), /^sso=/, 'ES256')
  assert.equal(await signInWithIdp(h, idp, 'stranger@example.com'), 'sso-error=no_account', 'no account, no provisioning')
  // A state is used once: replaying the callback fails.
  idp.next = { email: 'person@example.com', spoil: 'none' }
  const start = await h.request('GET', '/api/auth/sso/start', { ip: '198.51.100.200' })
  const cb = new URL((await fetch(new URL(start.headers['location']!), { redirect: 'manual' })).headers.get('location')!)
  assert.match(new URL((await h.request('GET', `/api/auth/sso/callback${cb.search}`)).headers['location']!).hash, /^#sso=/)
  assert.equal(new URL((await h.request('GET', `/api/auth/sso/callback${cb.search}`)).headers['location']!).hash, '#sso-error=expired')
  assert.equal(new URL((await h.request('GET', '/api/auth/sso/callback?error=access_denied&state=x')).headers['location']!).hash, '#sso-error=cancelled')
})

test('"require SSO" applies to password, recovery and passkey sign-in; owners are exempt', async () => {
  const { h, idp, owner } = await setup()
  assert.equal((await h.request('PUT', '/api/admin/settings', { token: owner, body: { policy: { ...POLICY, requireSso: true } } })).status, 200)
  assert.deepEqual((await h.request('GET', '/api/instance')).body['sso'], { name: 'Okta', required: true, provision: false })
  assert.equal((await login(h)).body['error'], 'sso_required')
  assert.equal((await h.request('POST', '/api/auth/recovery-login', { body: { email: 'person@example.com', recoveryAuthKey: fixtureB64('recovery-auth-key') } })).body['error'], 'sso_required')
  assert.equal((await login(h, {}, 'owner@example.com', fixtureB64('owner'))).status, 200, 'the owner can always get in')
  const t = ticketOf(await signInWithIdp(h, idp))
  const ok = await login(h, { ssoTicket: t })
  assert.equal(ok.status, 200)

  // A passkey sign-in needs the provider too.
  const token = String(ok.body['accessToken'])
  const key = new SoftAuthenticator()
  const o = await h.request('POST', '/api/auth/passkeys/options', { token, body: { currentAuthKey: fixtureB64('auth-key') } })
  await h.request('POST', '/api/auth/passkeys', { token, body: { response: key.register(o.body['options'] as { challenge: string }, { uv: true }), wrappedVaultKey: String(registration()['wrappedVaultKey']), sealedEmail: String(registration()['wrappedVaultKey']) } })
  const me = (await h.request('GET', '/api/auth/me', { token })).body['userId'] as string
  const opts = (await h.request('POST', '/api/auth/passkey-login/options', { ip: '192.0.2.251', body: {} })).body['options'] as { challenge: string }
  assert.equal((await h.request('POST', '/api/auth/passkey-login', { ip: '192.0.2.251', body: { response: key.assert(opts, { uv: true, userHandle: me }) } })).body['error'], 'sso_required')
  const t2 = ticketOf(await signInWithIdp(h, idp))
  const opts2 = (await h.request('POST', '/api/auth/passkey-login/options', { ip: '192.0.2.252', body: {} })).body['options'] as { challenge: string }
  assert.equal((await h.request('POST', '/api/auth/passkey-login', { ip: '192.0.2.252', body: { ssoTicket: t2, response: key.assert(opts2, { uv: true, userHandle: me }) } })).status, 200)
})

test('requiring SSO without a provider is refused; without OIDC the routes do not exist', async () => {
  const h = harness({ adminEmails: ['owner@example.com'], allowRegistration: true })
  const owner = String((await h.request('POST', '/api/auth/register', { body: registration({ email: 'owner@example.com', authKey: fixtureB64('owner') }) })).body['accessToken'])
  assert.equal((await h.request('PUT', '/api/admin/settings', { token: owner, body: { policy: { ...POLICY, requireSso: true } } })).status, 400)
  assert.equal((await h.request('GET', '/api/auth/sso/start')).status, 404)
  assert.equal((await h.request('GET', '/api/instance')).body['sso'], null)
})

test('with provisioning, the provider\'s person creates an account without an invitation, for that address only', async () => {
  const { h, idp } = await setup({ provision: true })
  const ticket = ticketOf(await signInWithIdp(h, idp, 'newcomer@example.com'))
  const info = await h.request('POST', '/api/auth/sso/ticket', { body: { ticket } })
  assert.deepEqual([info.body['email'], info.body['exists']], ['newcomer@example.com', false])
  // Registration is closed, and the ticket names another address.
  assert.equal((await h.request('POST', '/api/auth/register', { body: registration({ email: 'other@example.com', ssoTicket: ticket }) })).status, 403)
  const reg = await h.request('POST', '/api/auth/register', { body: registration({ email: 'newcomer@example.com', ssoTicket: ticket }) })
  assert.equal(reg.status, 201)
  assert.equal((await h.request('POST', '/api/auth/register', { body: registration({ email: 'newcomer@example.com', ssoTicket: ticket }) })).status, 403, 'used once')
})
