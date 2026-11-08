// The Vault API, from the extension: the same routes and headers as the web
// app, at the server address chosen at first run. Tokens go in a header, never
// cookies, so nothing here relies on the browser's session with the site.

import { friendlyError } from '@vault/core'
import type { KdfParams } from '@vault/crypto'

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message)
    this.name = 'ApiError'
  }
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
  me: (token: string) => request<{ userId: string; policy: { maxIdleMinutes: number | null } }>(server, 'GET', '/api/auth/me', { token }),
  vault: (token: string) => request<{ entries: { id: string; blob: string }[]; folders: { id: string; blob: string }[] }>(server, 'GET', '/api/vault', { token }),
})
