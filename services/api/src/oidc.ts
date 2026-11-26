// OpenID Connect, as a client (decisions/0021). The server runs the
// authorization code flow with PKCE against the operator's identity
// provider and checks the ID token itself: signature against the provider's
// published keys, issuer, audience, expiry and the nonce it sent. Nothing
// here touches a vault key: the provider proves who someone is, and the
// master password still opens the vault.

import { createHash, createPublicKey, randomBytes, verify, type JsonWebKey } from 'node:crypto'

import type { App } from './context.js'

export interface Discovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  token_endpoint_auth_methods_supported?: string[]
}

export class OidcError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'OidcError' }
}

const HOUR = 3600_000
let discoveryCache: { issuer: string; at: number; doc: Discovery } | null = null
let jwksCache: { uri: string; at: number; keys: (JsonWebKey & { kid?: string; alg?: string; use?: string })[] } | null = null

/** Tests only. */
export function forgetOidcCaches(): void { discoveryCache = null; jwksCache = null }

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new OidcError('provider_unavailable', `The identity provider answered ${res.status} for ${new URL(url).pathname}.`)
  return res.json()
}

export async function discover(app: App): Promise<Discovery> {
  const o = app.config.oidc!
  if (discoveryCache && discoveryCache.issuer === o.issuer && Date.now() - discoveryCache.at < HOUR) return discoveryCache.doc
  const doc = (await getJson(`${o.issuer}/.well-known/openid-configuration`)) as Partial<Discovery>
  // The document must name the issuer it was fetched for (OIDC Discovery 4.3).
  if (doc.issuer?.replace(/\/+$/, '') !== o.issuer) throw new OidcError('provider_misconfigured', 'The identity provider\'s discovery document names a different issuer.')
  for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
    if (typeof doc[k] !== 'string') throw new OidcError('provider_misconfigured', `The identity provider's discovery document has no ${k}.`)
  }
  discoveryCache = { issuer: o.issuer, at: Date.now(), doc: doc as Discovery }
  return doc as Discovery
}

async function keys(uri: string, refresh: boolean) {
  if (!refresh && jwksCache && jwksCache.uri === uri && Date.now() - jwksCache.at < HOUR) return jwksCache.keys
  const doc = (await getJson(uri)) as { keys?: unknown }
  const list = Array.isArray(doc.keys) ? (doc.keys as (JsonWebKey & { kid?: string })[]) : []
  jwksCache = { uri, at: Date.now(), keys: list }
  return list
}

const b64u = (b: Buffer) => b.toString('base64url')
export const randomToken = () => b64u(randomBytes(32))
export const pkceChallenge = (verifier: string) => b64u(createHash('sha256').update(verifier).digest())

export interface IdClaims { sub: string; email: string; emailVerified: boolean }

/** Checks an ID token and returns who it names. */
export async function verifyIdToken(app: App, token: string, nonce: string, now = app.now()): Promise<IdClaims> {
  const o = app.config.oidc!
  const parts = token.split('.')
  if (parts.length !== 3) throw new OidcError('bad_token', 'The identity provider sent a malformed ID token.')
  let header: { alg?: string; kid?: string }, claims: Record<string, unknown>
  try {
    header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8'))
    claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'))
  } catch { throw new OidcError('bad_token', 'The identity provider sent a malformed ID token.') }

  // Only asymmetric signatures: "none" and HMAC (which would use the client
  // secret, known to this server) are refused.
  const alg = header.alg
  if (alg !== 'RS256' && alg !== 'ES256' && alg !== 'PS256') throw new OidcError('bad_token', `ID tokens signed with ${alg ?? 'nothing'} are not accepted.`)
  const doc = await discover(app)
  const pick = (list: (JsonWebKey & { kid?: string; use?: string })[]) =>
    list.filter((k) => (k.use === undefined || k.use === 'sig') && (header.kid ? k.kid === header.kid : true) && (alg === 'ES256' ? k.kty === 'EC' : k.kty === 'RSA'))
  let candidates = pick(await keys(doc.jwks_uri, false))
  if (!candidates.length) candidates = pick(await keys(doc.jwks_uri, true)) // keys rotate
  const data = Buffer.from(`${parts[0]}.${parts[1]}`)
  const sig = Buffer.from(parts[2]!, 'base64url')
  const ok = candidates.some((jwk) => {
    try {
      const key = createPublicKey({ key: jwk, format: 'jwk' })
      if (alg === 'ES256') return verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig)
      if (alg === 'PS256') return verify('sha256', data, { key, padding: 6 /* RSA_PKCS1_PSS_PADDING */, saltLength: 32 }, sig)
      return verify('sha256', data, key, sig)
    } catch { return false }
  })
  if (!ok) throw new OidcError('bad_token', 'The ID token\'s signature did not verify against the identity provider\'s keys.')

  const seconds = Math.floor(now / 1000)
  const aud = claims['aud']
  const audiences = Array.isArray(aud) ? aud : [aud]
  if (String(claims['iss'] ?? '').replace(/\/+$/, '') !== o.issuer) throw new OidcError('bad_token', 'The ID token is from another issuer.')
  if (!audiences.includes(o.clientId)) throw new OidcError('bad_token', 'The ID token is for another application.')
  if (audiences.length > 1 && claims['azp'] !== o.clientId) throw new OidcError('bad_token', 'The ID token was issued to another party.')
  if (typeof claims['exp'] !== 'number' || claims['exp'] + 60 < seconds) throw new OidcError('bad_token', 'The ID token has expired.')
  if (typeof claims['iat'] === 'number' && claims['iat'] - 60 > seconds) throw new OidcError('bad_token', 'The ID token is dated in the future.')
  if (claims['nonce'] !== nonce) throw new OidcError('bad_token', 'The ID token does not answer this sign-in.')
  if (typeof claims['sub'] !== 'string' || !claims['sub']) throw new OidcError('bad_token', 'The ID token names nobody.')
  const email = typeof claims['email'] === 'string' ? claims['email'].trim().toLowerCase() : ''
  if (!email) throw new OidcError('no_email', 'The identity provider did not share an email address. Add the "email" scope or claim for this application.')
  const emailVerified = claims['email_verified'] === true || claims['email_verified'] === 'true'
  if (o.requireVerifiedEmail && !emailVerified) throw new OidcError('unverified_email', 'The identity provider has not verified this email address.')
  return { sub: claims['sub'], email, emailVerified }
}

/** Exchanges the authorization code (with the PKCE verifier) for tokens. */
export async function exchangeCode(app: App, code: string, verifier: string): Promise<string> {
  const o = app.config.oidc!
  const doc = await discover(app)
  const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(app), code_verifier: verifier })
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }
  // client_secret_basic is the default (OIDC Core 9); post only when the
  // provider says it lacks basic.
  const methods = doc.token_endpoint_auth_methods_supported
  if (methods && !methods.includes('client_secret_basic') && methods.includes('client_secret_post')) {
    form.set('client_id', o.clientId); form.set('client_secret', o.clientSecret)
  } else {
    headers['authorization'] = `Basic ${Buffer.from(`${encodeURIComponent(o.clientId)}:${encodeURIComponent(o.clientSecret)}`).toString('base64')}`
  }
  const res = await fetch(doc.token_endpoint, { method: 'POST', headers, body: form.toString(), redirect: 'error', signal: AbortSignal.timeout(10_000) })
  const body = (await res.json().catch(() => ({}))) as { id_token?: unknown; error?: unknown; error_description?: unknown }
  if (!res.ok || typeof body.id_token !== 'string') {
    throw new OidcError('exchange_failed', `The identity provider refused the sign-in${typeof body.error === 'string' ? ` (${body.error})` : ''}.`)
  }
  return body.id_token
}

export const redirectUri = (app: App) => `${app.config.origin}/api/auth/sso/callback`
