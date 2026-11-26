// A small OpenID Connect provider for tests: discovery, JWKS, an authorize
// endpoint that signs in whoever the test names at once, and a token endpoint
// that checks the code, the PKCE verifier and the client's secret. Its ID
// tokens can be spoiled one way at a time, to prove the server refuses each.

import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export type Spoil = 'none' | 'aud' | 'iss' | 'expired' | 'nonce' | 'signature' | 'alg-none' | 'hs256' | 'unverified' | 'no-email'

export interface MockIdp {
  issuer: string
  clientId: string
  clientSecret: string
  /** Who the next sign-in is, and how its token is spoiled. */
  next: { email: string; spoil: Spoil; es256?: boolean }
  /** Codes exchanged, for asserting PKCE and client authentication. */
  exchanges: { verifierOk: boolean; clientOk: boolean }[]
  close(): Promise<void>
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url')

export async function mockIdp(now: () => number): Promise<MockIdp> {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const codes = new Map<string, { nonce: string; challenge: string; email: string; spoil: Spoil; es256: boolean }>()
  const idp: MockIdp = {
    issuer: '', clientId: 'vault-test', clientSecret: 'a-client-secret-for-tests-only',
    next: { email: 'person@example.com', spoil: 'none' }, exchanges: [],
    close: () => new Promise((r) => server.close(() => r())),
  }

  function token(c: { nonce: string; email: string; spoil: Spoil; es256: boolean }): string {
    const s = Math.floor(now() / 1000)
    const alg = c.spoil === 'alg-none' ? 'none' : c.spoil === 'hs256' ? 'HS256' : c.es256 ? 'ES256' : 'RS256'
    const header = { alg, kid: c.es256 ? 'ec-1' : 'rsa-1', typ: 'JWT' }
    const claims: Record<string, unknown> = {
      iss: c.spoil === 'iss' ? 'https://evil.example' : idp.issuer, aud: c.spoil === 'aud' ? 'someone-else' : idp.clientId,
      sub: `sub-${c.email}`, iat: s, exp: c.spoil === 'expired' ? s - 3600 : s + 300, nonce: c.spoil === 'nonce' ? 'wrong' : c.nonce,
      ...(c.spoil === 'no-email' ? {} : { email: c.email.toUpperCase(), email_verified: c.spoil !== 'unverified' }),
    }
    const data = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`
    if (alg === 'none') return `${data}.`
    if (alg === 'HS256') return `${data}.${b64u(createHash('sha256').update(idp.clientSecret + data).digest())}`
    const key: KeyObject = c.spoil === 'signature' ? other.privateKey : c.es256 ? ec.privateKey : rsa.privateKey
    const sig = c.es256 ? sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }) : sign('sha256', Buffer.from(data), key)
    return `${data}.${b64u(sig)}`
  }

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', idp.issuer)
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body))
    }
    if (url.pathname === '/.well-known/openid-configuration') {
      return send(200, { issuer: idp.issuer, authorization_endpoint: `${idp.issuer}/authorize`, token_endpoint: `${idp.issuer}/token`, jwks_uri: `${idp.issuer}/jwks`, token_endpoint_auth_methods_supported: ['client_secret_basic'] })
    }
    if (url.pathname === '/jwks') {
      return send(200, { keys: [{ ...rsa.publicKey.export({ format: 'jwk' }), kid: 'rsa-1', use: 'sig', alg: 'RS256' }, { ...ec.publicKey.export({ format: 'jwk' }), kid: 'ec-1', use: 'sig', alg: 'ES256' }] })
    }
    if (url.pathname === '/authorize') {
      const p = url.searchParams
      if (p.get('client_id') !== idp.clientId || p.get('code_challenge_method') !== 'S256' || !p.get('nonce')) return send(400, { error: 'invalid_request' })
      const code = b64u(randomBytes(16))
      codes.set(code, { nonce: p.get('nonce')!, challenge: p.get('code_challenge')!, email: idp.next.email, spoil: idp.next.spoil, es256: idp.next.es256 === true })
      const back = new URL(p.get('redirect_uri')!)
      back.searchParams.set('code', code); back.searchParams.set('state', p.get('state')!)
      res.writeHead(302, { location: back.toString() }); return res.end()
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = ''
      req.on('data', (d) => { body += d })
      req.on('end', () => {
        const form = new URLSearchParams(body)
        const c = codes.get(form.get('code') ?? '')
        codes.delete(form.get('code') ?? '')
        const verifierOk = !!c && b64u(createHash('sha256').update(form.get('code_verifier') ?? '').digest()) === c.challenge
        const clientOk = req.headers.authorization === `Basic ${Buffer.from(`${idp.clientId}:${idp.clientSecret}`).toString('base64')}`
        idp.exchanges.push({ verifierOk, clientOk })
        if (!c || !verifierOk || !clientOk) return send(400, { error: 'invalid_grant' })
        send(200, { access_token: 'x', token_type: 'Bearer', id_token: token(c) })
      })
      return
    }
    send(404, {})
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  idp.issuer = `http://localhost:${(server.address() as AddressInfo).port}`
  return idp
}
