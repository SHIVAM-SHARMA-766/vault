// SAML 2.0 single sign-on (admin console phase 5), beside OIDC (decisions/0021):
// the identity provider answers "who are you", never "open the vault"; after
// it, the person still types their master password.
//
//   GET  /api/auth/sso/start           → 302 to the provider with an AuthnRequest
//   POST /api/auth/sso/saml/acs        ← the provider's signed response
//   GET  /api/auth/sso/saml/metadata   this server as a service provider
//
// The XML signature is checked by @node-saml/node-saml (xml-crypto, with its
// protections against signature wrapping), never by code of ours. What is
// required: a signed assertion from the configured certificate, for this
// audience, within its time window, answering a request this server made (its
// id is used once), and never seen before (replays are refused).

import { type CacheProvider, SAML, ValidateInResponseTo, generateServiceProviderMetadata } from '@node-saml/node-saml'

import type { App } from './context.js'
import { AlreadyExists } from './store.js'

const PK = 'SAML'
const REQUEST_SECONDS = 10 * 60

/** Request ids and seen assertions, in the database: any server of several
 *  can take the response, and each is accepted once. */
function cache(app: App): CacheProvider {
  const sk = (k: string) => `C#${k}`
  const expires = () => Math.floor(app.now() / 1000) + REQUEST_SECONDS
  return {
    saveAsync: async (key, value) => { await app.store.put({ pk: PK, sk: sk(key), value, createdAt: app.now(), expiresAt: expires() }); return { value, createdAt: app.now() } },
    getAsync: async (key) => { const r = await app.store.get(PK, sk(key)); return r && Number(r['expiresAt']) > Math.floor(app.now() / 1000) ? String(r['value']) : null },
    removeAsync: async (key) => { if (!key) return null; const r = await app.store.get(PK, sk(key)); await app.store.delete(PK, sk(key)); return r ? String(r['value']) : null },
    // Used once: the first to mark it gets the value, any copy gets nothing.
    consumeAsync: async (key) => {
      const r = await app.store.get(PK, sk(key))
      if (!r || Number(r['expiresAt']) <= Math.floor(app.now() / 1000)) return null
      try { await app.store.put({ pk: PK, sk: `U#${key}`, expiresAt: expires() }, { mustNotExist: true }) } catch (err) { if (err instanceof AlreadyExists) return null; throw err }
      await app.store.delete(PK, sk(key))
      return String(r['value'])
    },
    saveIfAbsentAsync: async (key, value, expiresAtMs) => {
      try { await app.store.put({ pk: PK, sk: `A#${key}`, value, expiresAt: Math.ceil(expiresAtMs / 1000) }, { mustNotExist: true }); return true } catch (err) { if (err instanceof AlreadyExists) return false; throw err }
    },
  }
}

export const acsUrl = (app: App) => `${app.config.origin}/api/auth/sso/saml/acs`

function client(app: App): SAML {
  const c = app.config.saml!
  return new SAML({
    entryPoint: c.ssoUrl, idpCert: c.cert, issuer: c.entityId, callbackUrl: acsUrl(app), audience: c.entityId,
    wantAssertionsSigned: true, wantAuthnResponseSigned: false,
    validateInResponseTo: ValidateInResponseTo.always, requestIdExpirationPeriodMs: REQUEST_SECONDS * 1000,
    rejectReplayedAssertions: true, cacheProvider: cache(app), acceptedClockSkewMs: 60_000,
    identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress', disableRequestedAuthnContext: true,
  } as ConstructorParameters<typeof SAML>[0])
}

export async function authorizeUrl(app: App): Promise<string> {
  return client(app).getAuthorizeUrlAsync('', undefined, {})
}

export class SamlRefused extends Error {}

/** The verified address in the provider's response, or SamlRefused. */
export async function verifiedEmail(app: App, samlResponse: string): Promise<string> {
  let result
  try { result = await client(app).validatePostResponseAsync({ SAMLResponse: samlResponse }) } catch (err) { throw new SamlRefused((err as Error).message) }
  const p = result.profile
  if (!p || result.loggedOut) throw new SamlRefused('no profile')
  const attr = app.config.saml!.emailAttribute
  const candidates = [
    attr ? p[attr] : undefined,
    p.nameID, p['email'], p['mail'],
    p['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'],
    p['urn:oid:0.9.2342.19200300.100.1.3'],
  ]
  for (const c of candidates) {
    const v = Array.isArray(c) ? c[0] : c
    if (typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())) return v.trim().toLowerCase()
  }
  throw new SamlRefused('no email in the assertion')
}

export function metadata(app: App): string {
  const c = app.config.saml!
  return generateServiceProviderMetadata({ issuer: c.entityId, callbackUrl: acsUrl(app), identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress', wantAssertionsSigned: true })
}
