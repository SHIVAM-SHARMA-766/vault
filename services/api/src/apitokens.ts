// Admin API tokens (admin console phase 5): service accounts for scripts and
// for SCIM provisioning. An owner makes one with chosen scopes and an expiry;
// the token is shown once and only its hash is kept. A token never carries
// roles.write or settings.write, and it cannot open any vault: it acts on
// accounts and invitations only, like staff do.
//
//   Authorization: Bearer vault_pat_<id>.<secret>     (or x-vault-auth)

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import type { App } from './context.js'
import { HttpError, type LambdaEvent, type LambdaResponse, badRequest, json, notFound, parseJsonBody, unauthorized } from './http.js'
import { SYSTEM_PK } from './keys.js'
import { enforce, API_LIMIT } from './ratelimit.js'
import type { Permission } from './roles.js'
import { audit } from './system.js'

export const TOKEN_SCOPES = ['overview.read', 'users.read', 'users.write', 'invites.read', 'invites.write', 'audit.read', 'scim'] as const
export type TokenScope = (typeof TOKEN_SCOPES)[number]
const DAYS = [30, 90, 365, null] as const
const PREFIX = 'APITOKEN#'
const tokenSk = (id: string) => `${PREFIX}${id}`
const TOKEN_RE = /^vault_pat_([A-Za-z0-9]{12})\.([A-Za-z0-9_-]{43})$/

export interface ApiToken { id: string; name: string; scopes: TokenScope[]; createdBy: string; createdAt: string; expiresAt: string | null; lastUsedAt?: string }

const hash = (secret: string) => createHash('sha256').update(secret).digest()

/** The bearer value of a request, from either header. */
function bearer(event: LambdaEvent): string | null {
  const raw = event.headers['authorization'] ?? event.headers['Authorization'] ?? event.headers['x-vault-auth'] ?? event.headers['X-Vault-Auth']
  const m = raw ? /^Bearer\s+(\S+)$/i.exec(raw.trim()) : null
  return m?.[1] ?? null
}

/** Whether this request is signed with an API token rather than a session. */
export const usesApiToken = (event: LambdaEvent): boolean => (bearer(event) ?? '').startsWith('vault_pat_')

/** The token behind a request, checked: known, unexpired, the secret right. */
export async function authenticateToken(app: App, event: LambdaEvent): Promise<ApiToken> {
  const m = TOKEN_RE.exec(bearer(event) ?? '')
  if (!m) throw unauthorized()
  const row = await app.store.get(SYSTEM_PK, tokenSk(m[1]!))
  if (!row) throw unauthorized()
  const stored = Buffer.from(String(row['secretHash']), 'base64url')
  const given = hash(m[2]!)
  if (stored.length !== given.length || !timingSafeEqual(stored, given)) throw unauthorized()
  if (row['expiresAt'] && Date.parse(String(row['expiresAt'])) <= app.now()) throw new HttpError(401, 'unauthorized', 'This API token has expired. Make a new one in the admin console.')
  await enforce(app.store, 'api-token', m[1]!, API_LIMIT, app.now())
  // When it was last used, at most once a minute (best effort).
  const last = row['lastUsedAt'] ? Date.parse(String(row['lastUsedAt'])) : 0
  if (app.now() - last > 60_000) void app.store.put({ ...row, lastUsedAt: new Date(app.now()).toISOString() }).catch(() => {})
  return toToken(row)
}

/** Refuses a token without the scope a route needs. */
export function requireScope(token: ApiToken, scope: Permission | 'scim'): void {
  if (!(token.scopes as string[]).includes(scope)) throw new HttpError(403, 'forbidden', `This API token does not have the "${scope}" scope.`)
}

function toToken(row: Record<string, unknown>): ApiToken {
  return {
    id: String(row['id']), name: String(row['name']), scopes: (row['scopes'] as TokenScope[]) ?? [], createdBy: String(row['createdBy']),
    createdAt: String(row['createdAt']), expiresAt: row['expiresAt'] ? String(row['expiresAt']) : null,
    ...(row['lastUsedAt'] ? { lastUsedAt: String(row['lastUsedAt']) } : {}),
  }
}

export async function listTokens(app: App): Promise<LambdaResponse> {
  const rows = await app.store.query(SYSTEM_PK, PREFIX)
  return json(200, { tokens: rows.map(toToken).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), scopes: TOKEN_SCOPES })
}

export async function createToken(app: App, actor: string, event: LambdaEvent): Promise<LambdaResponse> {
  const b = parseJsonBody<{ name?: unknown; scopes?: unknown; days?: unknown }>(event)
  const name = typeof b.name === 'string' ? b.name.trim() : ''
  if (!name || name.length > 60 || /[\u0000-\u001f<>]/.test(name)) throw badRequest('name is required: at most 60 characters.')
  if (!Array.isArray(b.scopes) || b.scopes.length === 0 || !b.scopes.every((s) => (TOKEN_SCOPES as readonly unknown[]).includes(s))) {
    throw badRequest(`scopes must be a list of: ${TOKEN_SCOPES.join(', ')}.`)
  }
  const days = b.days === undefined ? 90 : b.days
  if (!(DAYS as readonly unknown[]).includes(days)) throw badRequest('days must be 30, 90, 365 or null (no expiry).')
  if ((await app.store.query(SYSTEM_PK, PREFIX)).length >= 50) throw badRequest('A server has at most 50 API tokens. Revoke one first.')
  const id = randomBytes(9).toString('base64url').replace(/[-_]/g, 'x').slice(0, 12)
  const secret = randomBytes(32).toString('base64url')
  const at = new Date(app.now()).toISOString()
  const scopes = [...new Set(b.scopes as TokenScope[])]
  const expiresAt = days === null ? null : new Date(app.now() + (days as number) * 86_400_000).toISOString()
  await app.store.put({ pk: SYSTEM_PK, sk: tokenSk(id), id, name, scopes, createdBy: actor, createdAt: at, expiresAt, secretHash: hash(secret).toString('base64url') }, { mustNotExist: true })
  await audit(app, actor, 'token.create', `token:${id}`, `${name} (${scopes.join(' ')})`)
  return json(201, { token: `vault_pat_${id}.${secret}`, info: { id, name, scopes, createdBy: actor, createdAt: at, expiresAt } })
}

export async function revokeToken(app: App, actor: string, id: string): Promise<LambdaResponse> {
  const row = await app.store.get(SYSTEM_PK, tokenSk(id))
  if (!row) throw notFound()
  await app.store.delete(SYSTEM_PK, tokenSk(id))
  await audit(app, actor, 'token.revoke', `token:${id}`, String(row['name']))
  return json(200, { ok: true })
}

/** Names for audit records whose actor was a token. */
export async function tokenLabels(app: App): Promise<Map<string, string>> {
  return new Map((await app.store.query(SYSTEM_PK, PREFIX)).map((r) => [`token:${String(r['id'])}`, `API token "${String(r['name'])}"`]))
}
