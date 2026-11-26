// A tiny OpenID Connect provider for browser tests: its authorize endpoint
// signs in whoever `idp.email` names at once and sends the browser back.

import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { createServer } from 'node:http'

const b64u = (b) => Buffer.from(b).toString('base64url')

export async function mockIdp() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const codes = new Map()
  const idp = { issuer: '', clientId: 'vault-e2e', clientSecret: 'an-e2e-client-secret', email: 'person@example.test' }
  const server = createServer((req, res) => {
    const url = new URL(req.url, idp.issuer)
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (url.pathname === '/.well-known/openid-configuration') return send(200, { issuer: idp.issuer, authorization_endpoint: `${idp.issuer}/authorize`, token_endpoint: `${idp.issuer}/token`, jwks_uri: `${idp.issuer}/jwks` })
    if (url.pathname === '/jwks') return send(200, { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' }] })
    if (url.pathname === '/authorize') {
      const p = url.searchParams
      const code = b64u(randomBytes(16))
      codes.set(code, { nonce: p.get('nonce'), challenge: p.get('code_challenge'), email: idp.email })
      const back = new URL(p.get('redirect_uri'))
      back.searchParams.set('code', code); back.searchParams.set('state', p.get('state'))
      res.writeHead(302, { location: back.toString() }); return res.end()
    }
    if (url.pathname === '/token') {
      let body = ''
      req.on('data', (d) => { body += d })
      req.on('end', () => {
        const form = new URLSearchParams(body)
        const c = codes.get(form.get('code')); codes.delete(form.get('code'))
        if (!c || b64u(createHash('sha256').update(form.get('code_verifier') ?? '').digest()) !== c.challenge) return send(400, { error: 'invalid_grant' })
        const s = Math.floor(Date.now() / 1000)
        const data = `${b64u(JSON.stringify({ alg: 'RS256', kid: 'k1' }))}.${b64u(JSON.stringify({ iss: idp.issuer, aud: idp.clientId, sub: c.email, email: c.email, email_verified: true, nonce: c.nonce, iat: s, exp: s + 300 }))}`
        send(200, { id_token: `${data}.${b64u(sign('sha256', Buffer.from(data), privateKey))}`, token_type: 'Bearer', access_token: 'x' })
      })
      return
    }
    send(404, {})
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  idp.issuer = `http://localhost:${server.address().port}`
  idp.env = (extra = {}) => ({ OIDC_ISSUER: idp.issuer, OIDC_CLIENT_ID: idp.clientId, OIDC_CLIENT_SECRET: idp.clientSecret, OIDC_NAME: 'Okta', ...extra })
  idp.close = () => new Promise((r) => server.close(r))
  return idp
}
