// The HTTP client.
//
// Same origin as the page, so there is no base URL to configure and no CORS to
// arrange. The Content-Security-Policy restricts connect-src to 'self', which
// is what stops injected script from posting the vault somewhere else — that
// only holds while the API stays on this origin.

/** Not `Authorization`. See decisions/0004: a cross-origin form cannot set a
 *  custom header, so the token cannot be replayed by a cross-site request and
 *  the API needs no separate CSRF defence. */
const AUTH_HEADER = 'x-vault-auth'

export interface KdfParams {
  algorithm: 'PBKDF2-HMAC-SHA256'
  iterations: number
  salt: string
}

export interface Session {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly retryAfter: number | undefined

  constructor(status: number, code: string, message: string, retryAfter?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.retryAfter = retryAfter
  }
}

async function request<T>(
  method: string,
  path: string,
  options: { body?: unknown; token?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {}
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  if (options.token) headers[AUTH_HEADER] = `Bearer ${options.token}`

  let response: Response
  try {
    response = await fetch(path, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      // Nothing here relies on cookies, and sending them would only widen what
      // a cross-site request could do.
      credentials: 'omit',
      cache: 'no-store',
    })
  } catch {
    throw new ApiError(0, 'network', 'Could not reach the server.')
  }

  const text = await response.text()
  let payload: Record<string, unknown> = {}
  if (text) {
    try {
      payload = JSON.parse(text) as Record<string, unknown>
    } catch {
      throw new ApiError(response.status, 'malformed', 'The server sent something unreadable.')
    }
  }

  if (!response.ok) {
    const retryAfter = Number(response.headers.get('retry-after') ?? '')
    throw new ApiError(
      response.status,
      String(payload['error'] ?? 'error'),
      String(payload['message'] ?? 'Something went wrong.'),
      Number.isFinite(retryAfter) ? retryAfter : undefined,
    )
  }

  return payload as T
}

export const api = {
  health: () => request<{ status: string }>('GET', '/api/health'),

  /** The salt to derive with. An address with no account gets a decoy, so this
   *  answer does not reveal whether one exists. */
  prelogin: (email: string) =>
    request<{ kdf: KdfParams }>('POST', '/api/auth/prelogin', { body: { email } }),

  register: (body: {
    email: string
    authKey: string
    recoveryAuthKey: string
    kdf: KdfParams
    wrappedVaultKey: string
    wrappedVaultKeyForRecovery: string
  }) => request<Session & { userId: string }>('POST', '/api/auth/register', { body }),

  login: (email: string, authKey: string) =>
    request<Session & { wrappedVaultKey: string; kdf: KdfParams }>(
      'POST', '/api/auth/login', { body: { email, authKey } },
    ),

  recoveryLogin: (email: string, recoveryAuthKey: string) =>
    request<Session & { wrappedVaultKeyForRecovery: string }>(
      'POST', '/api/auth/recovery-login', { body: { email, recoveryAuthKey } },
    ),

  refresh: (refreshToken: string) =>
    request<Session>('POST', '/api/auth/refresh', { body: { refreshToken } }),

  logout: (token: string, refreshToken: string) =>
    request<{ ok: true }>('POST', '/api/auth/logout', { token, body: { refreshToken } }),

  me: (token: string) =>
    request<{ userId: string; kdf: KdfParams; wrappedVaultKey: string; createdAt: string }>(
      'GET', '/api/auth/me', { token },
    ),

  vault: (token: string) =>
    request<{
      entries: { id: string; blob: string; createdAt: string; updatedAt: string }[]
      folders: { id: string; blob: string; createdAt: string; updatedAt: string }[]
    }>('GET', '/api/vault', { token }),

  putEntry: (token: string, id: string, blob: string) =>
    request<{ id: string }>('PUT', `/api/vault/entries/${encodeURIComponent(id)}`, {
      token, body: { blob },
    }),

  deleteEntry: (token: string, id: string) =>
    request<{ ok: true }>('DELETE', `/api/vault/entries/${encodeURIComponent(id)}`, { token }),
}
