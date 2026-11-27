// SAML 2.0 single sign-on (admin console phase 5), against a test identity
// provider made here: an RSA key generated per run (nothing committed), whose
// public half is the configured certificate, and assertions signed with
// xml-crypto the way a real provider signs them.

import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'

import { SignedXml } from 'xml-crypto'

import { fixtureB64, harness, registration } from './harness.js'

const idp = generateKeyPairSync('rsa', { modulusLength: 2048 })
const IDP_KEY = idp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const IDP_PUB = idp.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const ORIGIN = 'https://vault.test'
const ENTITY = `${ORIGIN}/api/auth/sso/saml/metadata`
const ACS = `${ORIGIN}/api/auth/sso/saml/acs`

function setup(provision = false) {
  const h = harness({ adminEmails: ['owner@example.com'], allowRegistration: true, saml: { ssoUrl: 'https://idp.test/sso', cert: IDP_PUB, entityId: ENTITY, name: 'Contoso', provision, emailAttribute: '' } })
  return h
}

/** Starts a sign-in and returns the AuthnRequest's id. */
async function begin(h: ReturnType<typeof setup>): Promise<string> {
  const res = await h.request('GET', '/api/auth/sso/start', { ip: '198.51.100.20' })
  assert.equal(res.status, 302)
  const url = new URL(String(res.headers?.['location']))
  assert.equal(url.origin + url.pathname, 'https://idp.test/sso')
  const xml = inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest')!, 'base64')).toString('utf8')
  return /ID="([^"]+)"/.exec(xml)![1]!
}

/** A signed SAML response for `email`, answering `requestId`. */
function response(requestId: string, email: string, opts: { key?: string; audience?: string; minutesAgo?: number } = {}): string {
  const now = Date.now() - (opts.minutesAgo ?? 0) * 60_000
  const iso = (ms: number) => new Date(ms).toISOString()
  const aid = `_${randomUUID()}`
  const assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${aid}" Version="2.0" IssueInstant="${iso(now)}"><saml:Issuer>https://idp.test</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${email}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${requestId}" NotOnOrAfter="${iso(now + 5 * 60_000)}" Recipient="${ACS}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${iso(now - 60_000)}" NotOnOrAfter="${iso(now + 5 * 60_000)}"><saml:AudienceRestriction><saml:Audience>${opts.audience ?? ENTITY}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="${aid}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement></saml:Assertion>`
  const sig = new SignedXml({ privateKey: opts.key ?? IDP_KEY, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#' })
  sig.addReference({ xpath: `//*[local-name(.)='Assertion']`, transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'], digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' })
  sig.computeSignature(assertion, { location: { reference: `//*[local-name(.)='Issuer']`, action: 'after' } })
  const signed = sig.getSignedXml()
  const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_${randomUUID()}" Version="2.0" IssueInstant="${iso(now)}" Destination="${ACS}" InResponseTo="${requestId}"><saml:Issuer>https://idp.test</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${signed}</samlp:Response>`
  return Buffer.from(xml).toString('base64')
}

const post = (h: ReturnType<typeof setup>, samlResponse: string) =>
  h.request('POST', '/api/auth/sso/saml/acs', { ip: '198.51.100.21', rawHeaders: { 'content-type': 'application/x-www-form-urlencoded' }, rawBody: `SAMLResponse=${encodeURIComponent(samlResponse)}&RelayState=` })

test('a signed response for a request this server made gives a ticket for that account', async () => {
  const h = setup()
  await h.request('POST', '/api/auth/register', { ip: '198.51.100.1', body: registration({ email: 'asha@example.com', authKey: fixtureB64('asha') }) })
  const id = await begin(h)
  const res = await post(h, response(id, 'Asha@Example.com'))
  assert.equal(res.status, 302)
  const ticket = /#sso=([^&]+)$/.exec(String(res.headers?.['location']))?.[1]
  assert.ok(ticket, String(res.headers?.['location']))
  const info = await h.request('POST', '/api/auth/sso/ticket', { body: { ticket } })
  assert.deepEqual([info.body['email'], info.body['exists']], ['asha@example.com', true])
  assert.equal((await h.request('GET', '/api/instance')).body['sso'] && ((await h.request('GET', '/api/instance')).body['sso'] as { name: string }).name, 'Contoso')
})

test('refused: a replayed response, another key, the wrong audience, an old response, an unknown request', async () => {
  const h = setup()
  await h.request('POST', '/api/auth/register', { ip: '198.51.100.1', body: registration({ email: 'asha@example.com', authKey: fixtureB64('asha') }) })
  const refused = (res: { status: number; headers?: Record<string, string> }) => { assert.equal(res.status, 302); assert.match(String(res.headers?.['location']), /#sso-error=/) }

  const id = await begin(h)
  const good = response(id, 'asha@example.com')
  assert.match(String((await post(h, good)).headers?.['location']), /#sso=/)
  refused(await post(h, good))
  refused(await post(h, response(await begin(h), 'asha@example.com', { key: other })))
  refused(await post(h, response(await begin(h), 'asha@example.com', { audience: 'https://elsewhere.test' })))
  refused(await post(h, response(await begin(h), 'asha@example.com', { minutesAgo: 30 })))
  refused(await post(h, response('_never-asked', 'asha@example.com')))
  // A signed assertion with its address changed afterwards.
  const tampered = Buffer.from(Buffer.from(response(await begin(h), 'asha@example.com'), 'base64').toString('utf8').replace('asha@example.com</saml:NameID>', 'mallory@example.com</saml:NameID>')).toString('base64')
  refused(await post(h, tampered))
})

test('no account: refused unless the operator lets the provider\'s people sign up', async () => {
  const closed = setup(false)
  assert.match(String((await post(closed, response(await begin(closed), 'new@example.com'))).headers?.['location']), /sso-error=no_account/)
  const open = setup(true)
  const loc = String((await post(open, response(await begin(open), 'new@example.com'))).headers?.['location'])
  const ticket = /#sso=([^&]+)$/.exec(loc)![1]
  assert.equal((await open.request('POST', '/api/auth/sso/ticket', { body: { ticket } })).body['exists'], false)
})

test('the service provider metadata names this server and its assertion consumer', async () => {
  const h = setup()
  const res = await h.request('GET', '/api/auth/sso/saml/metadata')
  assert.equal(res.status, 200)
  assert.match(String(res.headers['content-type']), /samlmetadata\+xml/)
  assert.ok(res.raw.includes(`entityID="${ENTITY}"`))
  assert.ok(res.raw.includes(`Location="${ACS}"`))
})
