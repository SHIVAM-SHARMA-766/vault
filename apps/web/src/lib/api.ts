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

import { friendlyError } from '@vault/core'

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
    throw new ApiError(0, 'network', friendlyError({ status: 0, code: 'network', message: '' }))
  }

  const text = await response.text()
  let payload: Record<string, unknown> = {}
  if (text) {
    try {
      payload = JSON.parse(text) as Record<string, unknown>
    } catch {
      // Usually a proxy's error page while the server restarts.
      throw new ApiError(response.status, 'malformed', friendlyError({ status: response.status, code: 'malformed', message: '' }))
    }
  }

  if (!response.ok) {
    const retryAfter = Number(response.headers.get('retry-after') ?? '')
    const code = String(payload['error'] ?? 'error')
    const error = new ApiError(
      response.status,
      code,
      // Plain words and a next step (packages/core errors.ts). A server fault
      // keeps its request id, which matches the server's log.
      friendlyError({
        status: response.status, code, message: String(payload['message'] ?? ''),
        retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined,
        requestId: typeof payload['requestId'] === 'string' ? payload['requestId'] : undefined,
      }),
      Number.isFinite(retryAfter) ? retryAfter : undefined,
    )
    if (Array.isArray(payload['details'])) error.details = payload['details'] as { path: string; message: string }[]
    throw error
  }

  return payload as T
}

export interface UpdateStatus {
  enabled: boolean; current: string; latest: string | null; newer: boolean; url: string | null
  publishedAt: string | null; notes: string | null; checkedAt: string | null; error: string | null
}
export interface InstanceProfile { name: string; supportEmail: string; supportUrl: string }
export interface Instance extends InstanceProfile { registration: RegistrationMode; mail: boolean; firstRun: boolean; minPasswordScore: number }
/** Server-wide rules set by an administrator (G1, G3, G7). */
export interface ShareRow {
  id: string
  labelBlob: string
  createdAt: string
  expiresAt: string
  maxViews: number | null
  views: number
  status: 'live' | 'used' | 'expired' | 'revoked'
}

export interface ServerPolicy {
  requireTwoFactor: boolean
  minPasswordScore: number
  maxIdleMinutes: number | null
  sessionDays: number | null
  activityDays: number
  auditDays: number
}

export type BackupFrequency = 'off' | 'daily' | 'weekly' | 'monthly'
export interface BackupSchedule { frequency: BackupFrequency; hour: number; weekday: number; tzOffsetMinutes: number; keep: number }
export type BackupDestination =
  | { type: 'server' }
  | { type: 's3'; endpoint: string; region: string; bucket: string; prefix: string; accessKey: string; hasSecret: true }
  | { type: 'webdav'; url: string; username: string; hasSecret: true }
export type BackupDestinationInput =
  | { type: 'server' }
  | { type: 's3'; endpoint: string; region: string; bucket: string; prefix: string; accessKey: string; secretKey?: string }
  | { type: 'webdav'; url: string; username: string; password?: string }
export interface BackupRun { id: string; at: string; ok: boolean; destination: string; name: string; bytes: number; entries: number; reason: 'scheduled' | 'manual'; error?: string }
export interface BackupState {
  schedule: BackupSchedule
  destination: BackupDestination
  nextRunAt: string | null
  runs: BackupRun[]
  copies: { id: string; name: string; at: string; bytes: number }[]
  remoteAllowed: boolean
  serverKeepMax: number
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
    identity?: Identity
  }) => request<Session & { userId: string }>('POST', '/api/auth/register', { body }),

  /** Enrol an identity key pair on an account that has none (decisions/0009). */
  setIdentity: (token: string, identity: Identity) =>
    request<{ ok: true }>('PUT', '/api/keys/identity', { token, body: identity }),

  /** `second` is the two-factor code, when the server has asked for one
   *  (ApiError code 'two_factor_required'). */
  login: (email: string, authKey: string, second?: SecondFactor) =>
    request<Session & { wrappedVaultKey: string; kdf: KdfParams }>(
      'POST', '/api/auth/login', { body: { email, authKey, ...second } },
    ),

  recoveryLogin: (email: string, recoveryAuthKey: string, second?: SecondFactor) =>
    request<Session & { wrappedVaultKeyForRecovery: string }>(
      'POST', '/api/auth/recovery-login', { body: { email, recoveryAuthKey, ...second } },
    ),

  twoFactor: {
    setup: (token: string, currentAuthKey: string) =>
      request<{ secret: string }>('POST', '/api/auth/2fa/setup', { token, body: { currentAuthKey } }),
    enable: (token: string, code: string) =>
      request<{ recoveryCodes: string[] }>('POST', '/api/auth/2fa/enable', { token, body: { code } }),
    disable: (token: string, currentAuthKey: string, second: SecondFactor) =>
      request<{ ok: true }>('POST', '/api/auth/2fa/disable', { token, body: { currentAuthKey, ...second } }),
    recoveryCodes: (token: string, currentAuthKey: string, second: SecondFactor) =>
      request<{ recoveryCodes: string[] }>('POST', '/api/auth/2fa/recovery-codes', { token, body: { currentAuthKey, ...second } }),
  },

  refresh: (refreshToken: string) =>
    request<Session>('POST', '/api/auth/refresh', { body: { refreshToken } }),

  /** Revokes every session on the account, this one included. */
  logoutEverywhere: (token: string) =>
    request<{ ok: true }>('POST', '/api/auth/logout', { token, body: { all: true } }),

  /** A new master password. Proved by the current one, or — after signing in
   *  with the recovery key — by the recovery key. Signs out every other
   *  session and returns a fresh one. */
  changePassword: (token: string, body: {
    currentAuthKey?: string
    recoveryAuthKey?: string
    newAuthKey: string
    kdf: KdfParams
    wrappedVaultKey: string
  }) => request<Session>('POST', '/api/auth/change-password', { token, body }),

  /** A replacement recovery key; the old one stops working. */
  rotateRecovery: (token: string, body: {
    currentAuthKey: string
    recoveryAuthKey: string
    wrappedVaultKeyForRecovery: string
  }) => request<{ ok: true }>('POST', '/api/auth/recovery/rotate', { token, body }),

  logout: (token: string, refreshToken: string) =>
    request<{ ok: true }>('POST', '/api/auth/logout', { token, body: { refreshToken } }),

  /** Self-reported strength (0–4) of the master password, for organization policies. */
  passwordScore: (token: string, score: number) => request<{ ok: true }>('PUT', '/api/auth/password-score', { token, body: { score } }),
  me: (token: string) =>
    request<{ userId: string; kdf: KdfParams; wrappedVaultKey: string; createdAt: string; isAdmin: boolean; role: Role; permissions: Permission[]; identity: Identity | null; twoFactor: { enabled: boolean; recoveryCodesLeft: number }; policy: Pick<ServerPolicy, 'requireTwoFactor' | 'minPasswordScore' | 'maxIdleMinutes'>; policyGap: string | null }>(
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

  putFolder: (token: string, id: string, blob: string) =>
    request<{ id: string }>('PUT', `/api/vault/folders/${encodeURIComponent(id)}`, { token, body: { blob } }),

  deleteFolder: (token: string, id: string) =>
    request<{ ok: true }>('DELETE', `/api/vault/folders/${encodeURIComponent(id)}`, { token }),

  desk: {
    /** No account needed: ask for access, or for help signing in. */
    request: (body: { kind: 'access' | 'signin'; name: string; email: string; message: string }) =>
      request<{ number: number }>('POST', '/api/desk/requests', { body }),
    mine: (token: string) => request<{ tickets: Ticket[] }>('GET', '/api/desk/tickets', { token }),
    create: (token: string, body: { subject: string; category: string; message: string; email?: string }) =>
      request<{ ticket: Ticket }>('POST', '/api/desk/tickets', { token, body }),
    get: (token: string, id: string) =>
      request<{ ticket: Ticket; messages: TicketMessage[] }>('GET', `/api/desk/tickets/${encodeURIComponent(id)}`, { token }),
    reply: (token: string, id: string, body: string) =>
      request<{ ticket: Ticket }>('POST', `/api/desk/tickets/${encodeURIComponent(id)}/messages`, { token, body: { body } }),
    close: (token: string, id: string) =>
      request<{ ticket: Ticket }>('POST', `/api/desk/tickets/${encodeURIComponent(id)}/close`, { token }),
  },

  emergency: {
    mine: (token: string) => request<{ grants: EmergencyGrant[] }>('GET', '/api/emergency', { token }),
    create: (token: string, body: { email: string; label: string; fromName: string; waitDays: number }) => request<{ id: string }>('POST', '/api/emergency', { token, body }),
    trusted: (token: string) => request<{ invitations: { id: string; fromName: string; waitDays: number }[]; grants: EmergencyTrust[] }>('GET', '/api/emergency/trusted', { token }),
    accept: (token: string, id: string) => request<{ ok: true }>('POST', `/api/emergency/${id}/accept`, { token }),
    confirm: (token: string, id: string, keyBlob: string) => request<{ ok: true }>('POST', `/api/emergency/${id}/confirm`, { token, body: { keyBlob } }),
    request: (token: string, id: string) => request<{ ok: true; opensAt: string }>('POST', `/api/emergency/${id}/request`, { token }),
    approve: (token: string, id: string) => request<{ ok: true }>('POST', `/api/emergency/${id}/approve`, { token }),
    reject: (token: string, id: string) => request<{ ok: true }>('POST', `/api/emergency/${id}/reject`, { token }),
    revoke: (token: string, id: string) => request<{ ok: true }>('DELETE', `/api/emergency/${id}`, { token }),
    vault: (token: string, id: string) => request<{ keyBlob: string; entries: { id: string; blob: string }[]; folders: { id: string; blob: string }[] }>('GET', `/api/emergency/${id}/vault`, { token }),
  },

  orgs: {
    list: (token: string) => request<{ orgs: OrgRow[] }>('GET', '/api/orgs', { token }),
    create: (token: string, body: { id: string; hint: string; label: string; nameBlob: string; orgKeyBlob: string }) =>
      request<{ id: string }>('POST', '/api/orgs', { token, body }),
    remove: (token: string, org: string) => request<{ ok: true }>('DELETE', `/api/orgs/${org}`, { token }),
    invitations: (token: string) => request<{ invitations: OrgInvitation[] }>('GET', '/api/orgs/invitations', { token }),
    accept: (token: string, org: string) => request<{ ok: true }>('POST', `/api/orgs/${org}/accept`, { token }),
    decline: (token: string, org: string) => request<{ ok: true }>('POST', `/api/orgs/${org}/decline`, { token }),
    members: (token: string, org: string) => request<{ members: OrgMember[]; pending: OrgPending[] }>('GET', `/api/orgs/${org}/members`, { token }),
    invite: (token: string, org: string, email: string, label: string, role: 'member' | 'admin') =>
      request<{ ok: true }>('POST', `/api/orgs/${org}/invites`, { token, body: { email, label, role } }),
    withdraw: (token: string, org: string, id: string) => request<{ ok: true }>('DELETE', `/api/orgs/${org}/invites/${encodeURIComponent(id)}`, { token }),
    confirm: (token: string, org: string, user: string, orgKeyBlob: string) =>
      request<{ ok: true }>('POST', `/api/orgs/${org}/members/${user}/confirm`, { token, body: { orgKeyBlob } }),
    setRole: (token: string, org: string, user: string, role: 'admin' | 'member') =>
      request<{ ok: true }>('PUT', `/api/orgs/${org}/members/${user}`, { token, body: { role } }),
    removeMember: (token: string, org: string, user: string) =>
      request<{ ok: true; rotationNeeded: string[] }>('DELETE', `/api/orgs/${org}/members/${user}`, { token }),
    collections: (token: string, org: string) => request<{ collections: CollectionRow[] }>('GET', `/api/orgs/${org}/collections`, { token }),
    createCollection: (token: string, org: string, body: { id: string; nameBlob: string; keyBlob: string }) =>
      request<{ id: string }>('POST', `/api/orgs/${org}/collections`, { token, body }),
    deleteCollection: (token: string, org: string, coll: string) => request<{ ok: true }>('DELETE', `/api/orgs/${org}/collections/${coll}`, { token }),
    setPolicies: (token: string, org: string, policies: OrgPolicies) => request<{ policies: OrgPolicies }>('PUT', `/api/orgs/${org}/policies`, { token, body: policies }),
    report: (token: string, org: string, action: 'view' | 'reveal' | 'copy', collectionId: string, itemId: string) =>
      request<{ ok: true }>('POST', `/api/orgs/${org}/events`, { token, body: { action, collectionId, itemId } }),
    events: (token: string, org: string) =>
      request<{ events: { at: string; actor: string; action: string; collectionId: string | null; itemId: string | null; target: string | null; reported: boolean }[] }>('GET', `/api/orgs/${org}/events`, { token }),
    groups: (token: string, org: string) => request<{ groups: GroupRow[] }>('GET', `/api/orgs/${org}/groups`, { token }),
    createGroup: (token: string, org: string, id: string, nameBlob: string) => request<{ id: string }>('POST', `/api/orgs/${org}/groups`, { token, body: { id, nameBlob } }),
    deleteGroup: (token: string, org: string, group: string) => request<{ ok: true; rotationNeeded: string[] }>('DELETE', `/api/orgs/${org}/groups/${group}`, { token }),
    addToGroup: (token: string, org: string, group: string, user: string) =>
      request<{ ok: true; collections: { collectionId: string; permission: SharePermission; hidePasswords: boolean }[] }>('PUT', `/api/orgs/${org}/groups/${group}/members/${user}`, { token }),
    removeFromGroup: (token: string, org: string, group: string, user: string) =>
      request<{ ok: true; rotationNeeded: string[] }>('DELETE', `/api/orgs/${org}/groups/${group}/members/${user}`, { token }),
    grantGroup: (token: string, org: string, coll: string, group: string, body: { permission: SharePermission; hidePasswords: boolean; grants: { userId: string; keyBlob: string }[] }) =>
      request<{ ok: true; granted: number }>('PUT', `/api/orgs/${org}/collections/${coll}/groups/${group}`, { token, body }),
    revokeGroup: (token: string, org: string, coll: string, group: string) =>
      request<{ ok: true; rotationNeeded: string[] }>('DELETE', `/api/orgs/${org}/collections/${coll}/groups/${group}`, { token }),
    rotate: (token: string, org: string, coll: string, body: { keyVersion: number; grants: { userId: string; keyBlob: string }[]; items: { id: string; blob: string }[]; drop?: string[] }) =>
      request<{ keyVersion: number }>('POST', `/api/orgs/${org}/collections/${coll}/rotate`, { token, body }),
    access: (token: string, org: string, coll: string) =>
      request<{ access: { userId: string; permission: SharePermission; hidePasswords: boolean; keyVersion: number }[] }>('GET', `/api/orgs/${org}/collections/${coll}/access`, { token }),
    grant: (token: string, org: string, coll: string, user: string, body: { permission: SharePermission; hidePasswords: boolean; keyBlob?: string; viaGroup?: string }) =>
      request<{ ok: true }>('PUT', `/api/orgs/${org}/collections/${coll}/access/${user}`, { token, body }),
    revoke: (token: string, org: string, coll: string, user: string) =>
      request<{ ok: true }>('DELETE', `/api/orgs/${org}/collections/${coll}/access/${user}`, { token }),
    items: (token: string, org: string, coll: string) =>
      request<{ items: { id: string; blob: string; keyVersion: number; updatedAt: string }[] }>('GET', `/api/orgs/${org}/collections/${coll}/items`, { token }),
    putItem: (token: string, org: string, coll: string, item: string, blob: string, keyVersion: number) =>
      request<{ id: string }>('PUT', `/api/orgs/${org}/collections/${coll}/items/${item}`, { token, body: { blob, keyVersion } }),
    deleteItem: (token: string, org: string, coll: string, item: string) =>
      request<{ ok: true }>('DELETE', `/api/orgs/${org}/collections/${coll}/items/${item}`, { token }),
  },

  sessions: (token: string) => request<{ sessions: DeviceSession[] }>('GET', '/api/sessions', { token }),
  renameSession: (token: string, id: string, name: string) =>
    request<{ ok: true }>('PUT', `/api/sessions/${encodeURIComponent(id)}/name`, { token, body: { name } }),
  revokeSession: (token: string, id: string) =>
    request<{ ok: true }>('DELETE', `/api/sessions/${encodeURIComponent(id)}`, { token }),
  deleteAccount: (token: string, body: { currentAuthKey: string; confirm: 'DELETE'; totpCode?: string }) =>
    request<{ ok: true }>('POST', '/api/account/delete', { token, body }),
  /** What anyone may know about this server before signing in. */
  instance: () => request<Instance>('GET', '/api/instance'),
  shares: {
    create: (token: string, body: { id: string; blob: string; labelBlob: string; expiresIn: number; maxViews: number | null }) =>
      request<{ id: string; expiresAt: string; maxViews: number | null }>('POST', '/api/shares', { token, body }),
    list: (token: string) => request<{ shares: ShareRow[] }>('GET', '/api/shares', { token }),
    revoke: (token: string, id: string) => request<{ ok: true }>('DELETE', `/api/shares/${encodeURIComponent(id)}`, { token }),
    open: (id: string) => request<{ blob: string; expiresAt: string; viewsLeft: number | null }>('POST', `/api/shares/${encodeURIComponent(id)}/open`, {}),
  },
  prefs: (token: string) => request<{ blob: string | null; updatedAt?: string }>('GET', '/api/prefs', { token }),
  putPrefs: (token: string, blob: string) => request<{ updatedAt: string }>('PUT', '/api/prefs', { token, body: { blob } }),
  backups: {
    get: (token: string) => request<BackupState>('GET', '/api/backups', { token }),
    save: (token: string, body: { schedule: BackupSchedule; destination: BackupDestinationInput }) =>
      request<{ nextRunAt: string | null }>('PUT', '/api/backups/config', { token, body }),
    run: (token: string) => request<{ run: BackupRun }>('POST', '/api/backups/run', { token }),
    latest: (token: string) => request<{ name: string; body: string }>('GET', '/api/backups/latest', { token }),
    copy: (token: string, id: string) => request<{ name: string; body: string }>('GET', `/api/backups/copies/${encodeURIComponent(id)}`, { token }),
    deleteCopy: (token: string, id: string) => request<{ ok: true }>('DELETE', `/api/backups/copies/${encodeURIComponent(id)}`, { token }),
  },
  activity: (token: string) =>
    request<{ events: { kind: string; at: string; ip: string; device: string }[] }>('GET', '/api/activity', { token }),

  /** Previous versions of an entry, newest first, each sealed for history. */
  history: (token: string, id: string) =>
    request<{ versions: { at: string; blob: string }[] }>('GET', `/api/vault/history/${encodeURIComponent(id)}`, { token }),

  /** Creates many sealed items at once; never overwrites. At most 100
   *  entries and 50 folders per call. */
  importBulk: (token: string, body: { folders: { id: string; blob: string }[]; entries: { id: string; blob: string }[] }) =>
    request<{ folders: number; entries: number }>('POST', '/api/vault/import', { token, body }),

  addHistory: (token: string, id: string, blob: string) =>
    request<{ at: string }>('POST', `/api/vault/history/${encodeURIComponent(id)}`, { token, body: { blob } }),

  admin: {
    overview: (token: string) => request<AdminOverview>('GET', '/api/admin/overview', { token }),
    users: (token: string) => request<{ users: AdminUser[] }>('GET', '/api/admin/users', { token }),
    setLabel: (token: string, id: string, label: string) =>
      request<{ ok: true }>('PUT', `/api/admin/users/${encodeURIComponent(id)}/label`, { token, body: { label } }),
    setRole: (token: string, id: string, role: Role) =>
      request<{ ok: true }>('PUT', `/api/admin/users/${encodeURIComponent(id)}/role`, { token, body: { role } }),
    resetTwoFactor: (token: string, id: string) =>
      request<{ ok: true }>('POST', `/api/admin/users/${encodeURIComponent(id)}/reset-2fa`, { token }),
    setDisabled: (token: string, id: string, disabled: boolean) =>
      request<{ ok: true }>('PUT', `/api/admin/users/${encodeURIComponent(id)}/disabled`, { token, body: { disabled } }),
    revokeSessions: (token: string, id: string) =>
      request<{ ok: true }>('POST', `/api/admin/users/${encodeURIComponent(id)}/revoke-sessions`, { token }),
    deleteUser: (token: string, id: string) =>
      request<{ ok: true }>('POST', `/api/admin/users/${encodeURIComponent(id)}/delete`, { token, body: { confirm: id } }),
    settings: (token: string) =>
      request<{ registration: RegistrationMode; profile: InstanceProfile; policy: ServerPolicy; updatedAt?: string; registrationForcedOpen: boolean }>('GET', '/api/admin/settings', { token }),
    update: (token: string, refresh = false) => request<UpdateStatus>('GET', `/api/admin/update${refresh ? '?refresh=1' : ''}`, { token }),
    setProfile: (token: string, profile: InstanceProfile) =>
      request<{ ok: true }>('PUT', '/api/admin/settings', { token, body: { profile } }),
    setPolicy: (token: string, policy: ServerPolicy) =>
      request<{ ok: true }>('PUT', '/api/admin/settings', { token, body: { policy } }),
    setRegistration: (token: string, registration: RegistrationMode) =>
      request<{ ok: true }>('PUT', '/api/admin/settings', { token, body: { registration } }),
    invites: (token: string) => request<{ invites: AdminInvite[] }>('GET', '/api/admin/invites', { token }),
    bulkInvite: (token: string, people: { email: string; name?: string }[], days: number, role: Role) =>
      request<{ results: { email: string; label: string; emailed: boolean; expiresAt: string; code?: string }[]; mail: boolean; warning?: string }>('POST', '/api/admin/invites/bulk', { token, body: { people, days, role } }),
    createInvite: (token: string, label: string, days: number, role: Role = 'user', email = '') =>
      request<{ code: string; emailed: boolean; invite: { id: string; label: string; expiresAt: string; role: Role }; warning?: string }>(
        'POST', '/api/admin/invites', { token, body: { label, days, role, ...(email ? { email } : {}) } },
      ),
    orgs: (token: string) => request<{ orgs: AdminOrg[] }>('GET', '/api/admin/orgs', { token }),
    deleteOrg: (token: string, id: string) => request<{ ok: true }>('DELETE', `/api/admin/orgs/${id}`, { token }),
    desk: (token: string) => request<{ tickets: StaffTicket[]; counts: Record<TicketStatus, number> }>('GET', '/api/admin/desk', { token }),
    ticket: (token: string, id: string) =>
      request<{ ticket: StaffTicket; messages: TicketMessage[] }>('GET', `/api/admin/desk/${encodeURIComponent(id)}`, { token }),
    replyTicket: (token: string, id: string, body: string, internal: boolean) =>
      request<{ ticket: StaffTicket }>('POST', `/api/admin/desk/${encodeURIComponent(id)}/messages`, { token, body: { body, internal } }),
    updateTicket: (token: string, id: string, patch: { status?: TicketStatus; priority?: 'normal' | 'high'; assignee?: string | null }) =>
      request<{ ticket: StaffTicket }>('PUT', `/api/admin/desk/${encodeURIComponent(id)}`, { token, body: patch }),
    approveAccess: (token: string, id: string, role: Role = 'user') =>
      request<{ ticket: StaffTicket; code: string; emailed: boolean }>('POST', `/api/admin/desk/${encodeURIComponent(id)}/approve`, { token, body: { role } }),
    resetTicket2fa: (token: string, id: string) =>
      request<{ ticket: StaffTicket; hadTwoFactor: boolean }>('POST', `/api/admin/desk/${encodeURIComponent(id)}/reset-2fa`, { token }),
    testMail: (token: string, to: string) => request<{ sent: true }>('POST', '/api/admin/mail/test', { token, body: { to } }),
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

export interface EmergencyGrant { id: string; label: string; waitDays: number; status: string; granteePublicKey: string | null; requestedAt: string | null; opensAt: string | null }
export interface EmergencyTrust { id: string; fromName: string; waitDays: number; status: string; requestedAt: string | null; opensAt: string | null }
export interface AdminOrg {
  id: string; hint: string; createdAt: string; ownerId: string | null; members: number; awaiting: number; pending: number
  collections: number; items: number; rotationDue: number; policies: OrgPolicies
}
export type OrgRole = 'owner' | 'admin' | 'member'
export type SharePermission = 'view' | 'edit' | 'manage'
export interface OrgPolicies { requireTwoFactor: boolean; minPasswordScore: number; maxIdleMinutes: number | null }
export interface OrgRow { id: string; nameBlob: string; hint: string; role: OrgRole; status: 'accepted' | 'confirmed'; orgKeyBlob?: string; policies: OrgPolicies; policyGap: string | null }
export interface OrgInvitation { orgId: string; hint: string; role: OrgRole; invitedAt: string }
export interface OrgMember { userId: string; role: OrgRole; status: 'accepted' | 'confirmed'; label: string; publicKey: string; joinedAt: string; confirmedAt: string | null }
export interface OrgPending { id: string; label: string; role: OrgRole; invitedAt: string }
export interface GroupRow { id: string; nameBlob: string; members: string[]; collections: { collectionId: string; permission: SharePermission; hidePasswords: boolean }[] }
export interface CollectionRow {
  id: string; nameBlob: string; keyVersion: number; rotationNeeded: boolean
  access: { keyBlob: string; keyVersion: number; permission: SharePermission; hidePasswords: boolean } | null
}
export type TicketStatus = 'open' | 'in_progress' | 'waiting' | 'resolved' | 'closed'
export interface Ticket {
  id: string; number: number; kind: 'access' | 'signin' | 'support'; subject: string; category: string
  status: TicketStatus; createdAt: string; updatedAt: string; lastFrom: 'requester' | 'staff'; emailUpdates: boolean
}
export interface StaffTicket extends Ticket {
  priority: 'normal' | 'high'; assignee: string | null; closedAt: string | null
  requester: { userId: string | null; name: string | null; email: string | null; emailErased: boolean }
}
export interface TicketMessage { at: string; from: 'requester' | 'staff'; author: string; body: string; internal: boolean }
export interface DeviceSession { id: string; device: string; name?: string; ip: string; createdAt: string; lastUsedAt: string; current: boolean }
export type RegistrationMode = 'closed' | 'invite' | 'open'
/** A two-factor code: six digits from the authenticator app, or a recovery code. */
export type SecondFactor = { totpCode: string } | { recoveryCode: string }
/** Public key in the clear (base64url, 65 bytes); private key sealed under the vault key. */
export interface Identity { publicKey: string; wrappedPrivateKey: string }
export type Role = 'owner' | 'admin' | 'support' | 'marketing' | 'viewer' | 'user'
export type Permission =
  | 'overview.read' | 'users.read' | 'users.write' | 'roles.write' | 'invites.read' | 'invites.write'
  | 'settings.write' | 'audit.read' | 'site.read' | 'site.write' | 'site.publish' | 'desk.read' | 'desk.write'

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
  policyGapUsers: number
  entries: number
  activeSessions: number
  activeInvites: number
  registration: RegistrationMode
  registrationForcedOpen: boolean
  lastBackup: { at: string | null; object: string | null; bytes: number | null } | null
  mail: boolean
  openTickets: number
  version: string
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
  twoFactor: boolean
  policyGap: boolean
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
