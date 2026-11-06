// Access and refresh tokens.
//
// Deliberately not JWT. A JWT carries its own algorithm in a header that the
// verifier is then expected to trust, which is the root of the "alg: none" and
// algorithm-confusion families of bug. These tokens have one algorithm,
// HMAC-SHA256, named nowhere in the token and therefore not negotiable:
//
//     v1.<base64url(payload)>.<base64url(HMAC-SHA256(payload))>
//
// Access tokens are short-lived and never revoked individually. Refresh tokens
// carry an id that exists as a session item, so revoking one is a delete, and
// presenting one that has already been rotated away is detectable.

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

export const ACCESS_TTL_SECONDS = 15 * 60
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60

export type TokenType = 'access' | 'refresh'

export interface TokenPayload {
  sub: string
  typ: TokenType
  exp: number
  /** Refresh tokens only: the session this token belongs to. */
  jti?: string
  /** The device session (stable across refreshes) the token was issued to.
   *  Lets the API tell a caller which of its sessions is the current one. */
  sid?: string
}

const VERSION = 'v1'

function sign(payloadB64: string, key: string): string {
  return createHmac('sha256', key).update(payloadB64).digest('base64url')
}

export function issueToken(payload: TokenPayload, key: string): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${VERSION}.${body}.${sign(body, key)}`
}

export function issueAccessToken(userId: string, key: string, now = Date.now(), sid?: string): string {
  return issueToken(
    { sub: userId, typ: 'access', exp: Math.floor(now / 1000) + ACCESS_TTL_SECONDS, ...(sid ? { sid } : {}) },
    key,
  )
}

export function issueRefreshToken(
  userId: string,
  key: string,
  now = Date.now(),
): { token: string; tokenId: string; expiresAt: number } {
  const tokenId = randomUUID()
  const expiresAt = Math.floor(now / 1000) + REFRESH_TTL_SECONDS
  return {
    token: issueToken({ sub: userId, typ: 'refresh', exp: expiresAt, jti: tokenId }, key),
    tokenId,
    expiresAt,
  }
}

/** Returns null for anything that is not a currently valid token of the
 *  expected type. The caller never learns which check failed. */
export function verifyToken(
  token: string,
  expected: TokenType,
  key: string,
  now = Date.now(),
): TokenPayload | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null

  const [version, body, mac] = parts as [string, string, string]
  if (version !== VERSION) return null

  const expectedMac = Buffer.from(sign(body, key), 'base64url')
  const actualMac = Buffer.from(mac, 'base64url')
  if (expectedMac.length !== actualMac.length) return null
  if (!timingSafeEqual(expectedMac, actualMac)) return null

  let payload: TokenPayload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload
  } catch {
    return null
  }

  if (typeof payload.sub !== 'string' || payload.typ !== expected) return null
  if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(now / 1000)) return null
  if (expected === 'refresh' && typeof payload.jti !== 'string') return null

  return payload
}

/** The header the access token arrives in.
 *
 *  Not `Authorization`. CloudFront must populate that header with its own SigV4
 *  signature to satisfy the IAM-protected Function URL this service sits
 *  behind, so an origin request policy cannot forward the viewer's value — and
 *  one that tries produces a 403 with no invocation and no log line, which is
 *  easily mistaken for the access control working.
 *
 *  Using a custom header has an incidental benefit: a cross-origin form cannot
 *  set one, so the token cannot be replayed by a cross-site request the way a
 *  cookie could. */
export const AUTH_HEADER = 'x-vault-auth'

/** `x-vault-auth: Bearer <token>`, case-insensitively. */
export function bearerFrom(headers: Record<string, string | undefined>): string | null {
  const raw = headers[AUTH_HEADER] ?? headers['X-Vault-Auth']
  if (!raw) return null
  const match = /^Bearer\s+(\S+)$/i.exec(raw.trim())
  return match?.[1] ?? null
}
