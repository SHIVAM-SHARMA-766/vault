// The Vault API, from the extension: the same routes and headers as the web
// app, at the server address chosen at first run. Tokens go in a header, never
// cookies, so nothing here relies on the browser's session with the site.

import { friendlyError } from '@vault/core'
import type { KdfParams } from '@vault/crypto'

import type { MemberKeys } from '../../web/src/features/orgs/grants.js'

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message)
    this.name = 'ApiError'
  }
}

export interface Me {
  userId: string
  policy: { maxIdleMinutes: number | null }
  identity: { publicKey: string; wrappedPrivateKey: string; signingPublicKey?: string } | null
}
export interface OrgRow {
  id: string; nameBlob: string; kind?: 'team' | 'direct'; status: 'accepted' | 'confirmed'
  orgKeyBlob?: string; policies: { maxIdleMinutes: number | null }; policyGap: string | null
}
export interface CollectionRow {
  id: string; nameBlob: string; keyVersion: number
  access: { keyBlob: string; keyVersion: number; permission: string; hidePasswords: boolean; signature?: string; signedBy?: string } | null
}

export interface Session { accessToken: string; refreshToken: string; expiresIn: number }

async function request<T>(server: string, method: string, path: string, options: { body?: unknown; token?: string } = {}): Promise<T> {
  const headers: Record<string, string> = {}
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  if (options.token) headers['x-vault-auth'] = `Bearer ${options.token}`
  let response: Response
  try {
    response = await fetch(new URL(path, server), {
      method, headers, credentials: 'omit', cache: 'no-store',
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
  } catch {
    throw new ApiError(0, 'network', friendlyError({ status: 0, code: 'network', message: '' }))
  }
  const text = await response.text()
  let payload: Record<string, unknown> = {}
  try { payload = text ? JSON.parse(text) as Record<string, unknown> : {} } catch {
    throw new ApiError(response.status, 'malformed', friendlyError({ status: response.status, code: 'malformed', message: '' }))
  }
  if (!response.ok) {
    const code = String(payload['error'] ?? 'error')
    const retry = Number(response.headers.get('retry-after') ?? '')
    throw new ApiError(response.status, code, friendlyError({
      status: response.status, code, message: String(payload['message'] ?? ''),
      retryAfter: Number.isFinite(retry) ? retry : undefined,
      requestId: typeof payload['requestId'] === 'string' ? payload['requestId'] : undefined,
    }), payload['details'])
  }
  return payload as T
}

export const api = (server: string) => ({
  instance: () => request<{ name: string; registration: string }>(server, 'GET', '/api/instance'),
  prelogin: (email: string) => request<{ kdf: KdfParams }>(server, 'POST', '/api/auth/prelogin', { body: { email } }),
  login: (email: string, authKey: string, second?: Record<string, string>) =>
    request<Session & { wrappedVaultKey: string; kdf: KdfParams }>(server, 'POST', '/api/auth/login', { body: { email, authKey, ...second } }),
  refresh: (refreshToken: string) => request<Session>(server, 'POST', '/api/auth/refresh', { body: { refreshToken } }),
  logout: (token: string) => request<{ ok: true }>(server, 'POST', '/api/auth/logout', { token, body: {} }),
  me: (token: string) => request<Me>(server, 'GET', '/api/auth/me', { token }),
  // Shared collections (decisions/0015, 0025): read only.
  orgs: (token: string) => request<{ orgs: OrgRow[] }>(server, 'GET', '/api/orgs', { token }),
  members: (token: string, org: string) => request<{ members: MemberKeys[] }>(server, 'GET', `/api/orgs/${org}/members`, { token }),
  getTrust: (token: string, org: string) => request<{ blob: string | null }>(server, 'GET', `/api/orgs/${org}/trust`, { token }),
  putTrust: (token: string, org: string, blob: string) => request<{ ok: true }>(server, 'PUT', `/api/orgs/${org}/trust`, { token, body: { blob } }),
  collections: (token: string, org: string) => request<{ collections: CollectionRow[] }>(server, 'GET', `/api/orgs/${org}/collections`, { token }),
  items: (token: string, org: string, coll: string) =>
    request<{ items: { id: string; blob: string; keyVersion: number; sensitive?: boolean }[] }>(server, 'GET', `/api/orgs/${org}/collections/${coll}/items`, { token }),
  /** Filling and copying a shared item are reported, as in the web app. */
  report: (token: string, org: string, action: 'copy' | 'fill', collectionId: string, itemId: string) =>
    request<{ ok: true }>(server, 'POST', `/api/orgs/${org}/events`, { token, body: { action, collectionId, itemId } }),
  vault: (token: string) => request<{ entries: { id: string; blob: string }[]; folders: { id: string; blob: string }[] }>(server, 'GET', '/api/vault', { token }),
})
