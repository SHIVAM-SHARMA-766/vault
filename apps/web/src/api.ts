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
  /** Field-level problems the server reported, for a 400 on website content. */
  details?: { path: string; message: string }[]

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
    const error = new ApiError(
      response.status,
      String(payload['error'] ?? 'error'),
      String(payload['message'] ?? 'Something went wrong.'),
      Number.isFinite(retryAfter) ? retryAfter : undefined,
    )
    if (Array.isArray(payload['details'])) error.details = payload['details'] as { path: string; message: string }[]
    throw error
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
    inviteCode?: string
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
    request<{ userId: string; kdf: KdfParams; wrappedVaultKey: string; createdAt: string; isAdmin: boolean; role: Role; permissions: Permission[] }>(
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

  admin: {
    overview: (token: string) => request<AdminOverview>('GET', '/api/admin/overview', { token }),
    users: (token: string) => request<{ users: AdminUser[] }>('GET', '/api/admin/users', { token }),
    setLabel: (token: string, id: string, label: string) =>
      request<{ ok: true }>('PUT', `/api/admin/users/${encodeURIComponent(id)}/label`, { token, body: { label } }),
    setRole: (token: string, id: string, role: Role) =>
      request<{ ok: true }>('PUT', `/api/admin/users/${encodeURIComponent(id)}/role`, { token, body: { role } }),
    setDisabled: (token: string, id: string, disabled: boolean) =>
      request<{ ok: true }>('PUT', `/api/admin/users/${encodeURIComponent(id)}/disabled`, { token, body: { disabled } }),
    revokeSessions: (token: string, id: string) =>
      request<{ ok: true }>('POST', `/api/admin/users/${encodeURIComponent(id)}/revoke-sessions`, { token }),
    deleteUser: (token: string, id: string) =>
      request<{ ok: true }>('POST', `/api/admin/users/${encodeURIComponent(id)}/delete`, { token, body: { confirm: id } }),
    settings: (token: string) =>
      request<{ registration: RegistrationMode; updatedAt?: string; registrationForcedOpen: boolean }>('GET', '/api/admin/settings', { token }),
    setRegistration: (token: string, registration: RegistrationMode) =>
      request<{ ok: true }>('PUT', '/api/admin/settings', { token, body: { registration } }),
    invites: (token: string) => request<{ invites: AdminInvite[] }>('GET', '/api/admin/invites', { token }),
    createInvite: (token: string, label: string, days: number, role: Role = 'user') =>
      request<{ code: string; invite: { id: string; label: string; expiresAt: string; role: Role } }>(
        'POST', '/api/admin/invites', { token, body: { label, days, role } },
      ),
    deleteInvite: (token: string, id: string) =>
      request<{ ok: true }>('DELETE', `/api/admin/invites/${encodeURIComponent(id)}`, { token }),
    audit: (token: string) => request<{ records: AdminAudit[] }>('GET', '/api/admin/audit', { token }),
    site: (token: string) => request<SiteState>('GET', '/api/admin/site', { token }),
    saveDraft: (token: string, content: SiteContent) =>
      request<{ ok: true; content: SiteContent }>('PUT', '/api/admin/site/draft', { token, body: { content } }),
    discardDraft: (token: string) => request<{ ok: true }>('DELETE', '/api/admin/site/draft', { token }),
    preview: (token: string, content: SiteContent, page: string) =>
      request<{ html: string }>('POST', '/api/admin/site/preview', { token, body: { content, page } }),
    publish: (token: string, note: string) =>
      request<{ ok: true; version: string }>('POST', '/api/admin/site/publish', { token, body: { note } }),
    rollback: (token: string, version: string) =>
      request<{ ok: true }>('POST', `/api/admin/site/rollback/${encodeURIComponent(version)}`, { token }),
    uploadMedia: (token: string, name: string, data: string) =>
      request<{ media: SiteMedia }>('POST', '/api/admin/media', { token, body: { name, data } }),
    deleteMedia: (token: string, id: string) =>
      request<{ ok: true }>('DELETE', `/api/admin/media/${encodeURIComponent(id)}`, { token }),
  },
}

export type RegistrationMode = 'closed' | 'invite' | 'open'
export type Role = 'owner' | 'admin' | 'marketing' | 'viewer' | 'user'
export type Permission =
  | 'overview.read' | 'users.read' | 'users.write' | 'roles.write' | 'invites.read' | 'invites.write'
  | 'settings.write' | 'audit.read' | 'site.read' | 'site.write' | 'site.publish'

export type SiteContent = Record<string, Record<string, Record<string, unknown>>>
export interface SiteMedia { id: string; type: string; name: string; bytes: number; uploadedAt: string; uploadedBy: string }
export interface SiteField {
  key: string; label: string; type: 'text' | 'textarea' | 'bool' | 'select' | 'icon' | 'link' | 'image' | 'list'
  max?: number; hint?: string; options?: [string, string][]; fallback?: string
  min?: number; itemLabel?: string; fields?: SiteField[]
}
export interface SiteSchema { version: number; sections: { id: string; label: string; hint?: string; groups: { key: string; label: string; hint?: string; fields: SiteField[] }[] }[] }
export interface SiteState {
  schema: SiteSchema
  defaults: SiteContent
  live: { version: string | null; content: SiteContent; publishedAt: string | null; publishedBy: string | null }
  draft: { content: SiteContent; updatedAt: string | null; updatedBy: string | null } | null
  versions: { version: string; publishedAt: string | null; publishedBy: string | null; note: string | null }[]
  media: SiteMedia[]
}

export interface AdminOverview {
  users: number
  disabledUsers: number
  entries: number
  activeSessions: number
  activeInvites: number
  registration: RegistrationMode
  registrationForcedOpen: boolean
  lastBackup: { at: string | null; object: string | null; bytes: number | null } | null
  serverTime: string
  uptimeSeconds: number
}

export interface AdminUser {
  userId: string
  label: string | null
  createdAt: string
  lastLoginAt: string | null
  disabled: boolean
  isAdmin: boolean
  role: Role
  entries: number
  folders: number
  sessions: number
}

export interface AdminInvite {
  id: string
  label: string
  createdAt: string
  expiresAt: string
  usedAt: string | null
  usedBy: string | null
  role: Role
  status: 'active' | 'used' | 'expired'
}

export interface AdminAudit {
  at: string
  actor: string
  action: string
  target: string | null
  detail: string | null
  actorLabel: string | null
  targetLabel: string | null
}
