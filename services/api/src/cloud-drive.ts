// Personal backups to Google Drive and OneDrive (decisions/0024).
//
// Each person connects their own account with OAuth (authorization code and
// PKCE) to the operator's registered app. Vault asks for the narrowest access
// each offers:
//   Google Drive  drive.file                 only files Vault created
//   OneDrive      Files.ReadWrite.AppFolder  only Vault's own app folder
// The refresh token is sealed at rest like a WebDAV password, so scheduled
// backups run while the person is away. Requests go only to the providers'
// fixed hosts, never to an address a person typed.

import { createHash, randomBytes } from 'node:crypto'

import type { App } from './context.js'

export type CloudProvider = 'gdrive' | 'onedrive'
export const CLOUD_PROVIDERS: readonly CloudProvider[] = ['gdrive', 'onedrive']

const DEFAULT_ENDPOINTS = {
  googleAuth: 'https://accounts.google.com/o/oauth2/v2/auth',
  googleToken: 'https://oauth2.googleapis.com/token',
  googleApi: 'https://www.googleapis.com',
  msAuth: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  msToken: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  msGraph: 'https://graph.microsoft.com',
}
const ep = (app: App) => ({ ...DEFAULT_ENDPOINTS, ...app.config.cloudDrive.endpoints })

const SCOPES: Record<CloudProvider, string> = {
  gdrive: 'openid email https://www.googleapis.com/auth/drive.file',
  onedrive: 'openid email offline_access Files.ReadWrite.AppFolder',
}

export const PROVIDER_NAMES: Record<CloudProvider, string> = { gdrive: 'Google Drive', onedrive: 'OneDrive' }

export class CloudError extends Error {
  constructor(message: string) { super(message); this.name = 'CloudError' }
}

const client = (app: App, p: CloudProvider) => (p === 'gdrive' ? app.config.cloudDrive.google : app.config.cloudDrive.microsoft)
export const providerConfigured = (app: App, p: CloudProvider) => client(app, p) !== null && app.config.personalBackup.remote
export const redirectUri = (app: App) => `${app.config.origin}/api/backups/oauth/callback`

const OAUTH_PK = 'CLOUDOAUTH'
const STATE_SECONDS = 10 * 60
const b64u = (b: Buffer) => b.toString('base64url')
const hash = (s: string) => createHash('sha256').update(s).digest('base64url')

/** The provider's consent page, for this person. */
export async function connectUrl(app: App, userId: string, provider: CloudProvider): Promise<string> {
  const c = client(app, provider)
  if (!c) throw new CloudError(`${PROVIDER_NAMES[provider]} is not set up on this server.`)
  const state = b64u(randomBytes(32)), verifier = b64u(randomBytes(32))
  await app.store.put({ pk: OAUTH_PK, sk: `S#${hash(state)}`, userId, provider, verifier, expiresAt: Math.floor(app.now() / 1000) + STATE_SECONDS })
  const url = new URL(provider === 'gdrive' ? ep(app).googleAuth : ep(app).msAuth)
  const params: Record<string, string> = {
    response_type: 'code', client_id: c.clientId, redirect_uri: redirectUri(app), scope: SCOPES[provider], state,
    code_challenge: b64u(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
    // Google issues a refresh token only with offline access and fresh consent.
    ...(provider === 'gdrive' ? { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false' } : { prompt: 'select_account' }),
  }
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return url.toString()
}

async function tokenRequest(app: App, provider: CloudProvider, form: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; id_token?: string }> {
  const c = client(app, provider)!
  const res = await fetch(provider === 'gdrive' ? ep(app).googleToken : ep(app).msToken, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ ...form, client_id: c.clientId, client_secret: c.clientSecret }).toString(),
  })
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; id_token?: string; error?: string }
  if (!res.ok || !body.access_token) {
    throw new CloudError(body.error === 'invalid_grant'
      ? `${PROVIDER_NAMES[provider]} no longer accepts Vault's access (it was revoked or expired). Connect it again in Settings → Backups.`
      : `${PROVIDER_NAMES[provider]} refused the sign-in${body.error ? ` (${body.error})` : ''}.`)
  }
  return body as { access_token: string; refresh_token?: string; id_token?: string }
}

/** Who connected, for the label only: the ID token arrived straight from the
 *  provider's token endpoint over TLS, and nothing is decided by it. */
function accountOf(idToken: string | undefined): string {
  try {
    const claims = JSON.parse(Buffer.from(String(idToken).split('.')[1] ?? '', 'base64url').toString('utf8')) as { email?: string; preferred_username?: string }
    return String(claims.email ?? claims.preferred_username ?? '').slice(0, 200)
  } catch { return '' }
}

export interface Connected { userId: string; provider: CloudProvider; account: string; refreshToken: string; folderId?: string }

/** The provider's answer: the code exchanged for a refresh token, and for
 *  Google, the folder Vault will write into. */
export async function finishConnect(app: App, state: string, code: string): Promise<Connected> {
  const row = state ? await app.store.get(OAUTH_PK, `S#${hash(state)}`) : null
  if (!row || Number(row['expiresAt']) < Math.floor(app.now() / 1000)) throw new CloudError('That took too long. Connect again.')
  await app.store.delete(OAUTH_PK, `S#${hash(state)}`)
  const provider = row['provider'] as CloudProvider
  const tokens = await tokenRequest(app, provider, { grant_type: 'authorization_code', code, redirect_uri: redirectUri(app), code_verifier: String(row['verifier']) })
  if (!tokens.refresh_token) throw new CloudError(`${PROVIDER_NAMES[provider]} did not grant offline access, which scheduled backups need. Connect again and allow it.`)
  const connected: Connected = { userId: String(row['userId']), provider, account: accountOf(tokens.id_token), refreshToken: tokens.refresh_token }
  if (provider === 'gdrive') {
    const res = await api(app, tokens.access_token, 'POST', `${ep(app).googleApi}/drive/v3/files?fields=id`, JSON.stringify({ name: 'Vault backups', mimeType: 'application/vnd.google-apps.folder' }), 'application/json')
    connected.folderId = String((JSON.parse(res.toString('utf8')) as { id: string }).id)
  }
  return connected
}

async function api(app: App, token: string | null, method: string, url: string, body?: Buffer | string, type?: string, extra: Record<string, string> = {}): Promise<Buffer> {
  void app
  const res = await fetch(url, {
    method, signal: AbortSignal.timeout(120_000), redirect: 'follow',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(type ? { 'content-type': type } : {}), ...extra },
    ...(body !== undefined ? { body } : {}),
  })
  const out = Buffer.from(await res.arrayBuffer())
  if (!res.ok) {
    throw new CloudError(res.status === 401 || res.status === 403 ? `The cloud drive refused Vault's access (${res.status}). Connect it again in Settings → Backups.`
      : res.status === 404 ? 'That backup is no longer in the cloud drive.'
      : res.status === 507 || /quota/i.test(out.toString('utf8')) ? 'The cloud drive is full.'
      : `The cloud drive answered ${res.status}.`)
  }
  return out
}

/** What a stored cloud destination holds (the token sealed by the caller). */
export interface CloudTarget { provider: CloudProvider; folderId?: string }

/** A fresh access token. Microsoft rotates refresh tokens: a new one is handed
 *  to `keep` so the stored copy stays current. */
export async function accessToken(app: App, provider: CloudProvider, refreshToken: string, keep: (rotated: string) => Promise<void>): Promise<string> {
  const t = await tokenRequest(app, provider, { grant_type: 'refresh_token', refresh_token: refreshToken, ...(provider === 'onedrive' ? { scope: SCOPES.onedrive } : {}) })
  if (t.refresh_token && t.refresh_token !== refreshToken) await keep(t.refresh_token)
  return t.access_token
}

const graphPath = (app: App, name: string) => `${ep(app).msGraph}/v1.0/me/drive/special/approot:/${encodeURIComponent(name)}:`
/** OneDrive takes a single PUT up to 4 MB; larger files go in chunks, each a
 *  multiple of 320 KiB. */
const SMALL = 4 * 1024 * 1024
const CHUNK = 10 * 320 * 1024

/** Uploads; returns the file's id at the provider. */
export async function upload(app: App, token: string, t: CloudTarget, name: string, body: Buffer): Promise<string> {
  if (t.provider === 'gdrive') {
    // Resumable: metadata first, then the bytes, in two requests of any size.
    const res = await fetch(`${ep(app).googleApi}/upload/drive/v3/files?uploadType=resumable&fields=id`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': 'application/json', 'x-upload-content-length': String(body.length) },
      body: JSON.stringify({ name, parents: t.folderId ? [t.folderId] : [] }),
    })
    const session = res.headers.get('location')
    if (!res.ok || !session) throw new CloudError(`Google Drive did not start the upload (${res.status}).`)
    const done = await api(app, token, 'PUT', session, body, 'application/json')
    return String((JSON.parse(done.toString('utf8')) as { id: string }).id)
  }
  if (body.length <= SMALL) {
    const done = await api(app, token, 'PUT', `${graphPath(app, name)}/content`, body, 'application/json')
    return String((JSON.parse(done.toString('utf8')) as { id: string }).id)
  }
  const s = await api(app, token, 'POST', `${graphPath(app, name)}/createUploadSession`, JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }), 'application/json')
  const uploadUrl = String((JSON.parse(s.toString('utf8')) as { uploadUrl: string }).uploadUrl)
  let last: Buffer = Buffer.alloc(0)
  for (let start = 0; start < body.length; start += CHUNK) {
    const end = Math.min(start + CHUNK, body.length)
    // The upload URL carries its own authorization; the bearer token must not be sent to it.
    last = await api(app, null, 'PUT', uploadUrl, body.subarray(start, end), 'application/octet-stream', { 'content-range': `bytes ${start}-${end - 1}/${body.length}` })
  }
  return String((JSON.parse(last.toString('utf8')) as { id?: string }).id ?? name)
}

export async function download(app: App, token: string, t: CloudTarget, name: string, id: string): Promise<Buffer> {
  return t.provider === 'gdrive'
    ? api(app, token, 'GET', `${ep(app).googleApi}/drive/v3/files/${encodeURIComponent(id)}?alt=media`)
    : api(app, token, 'GET', `${graphPath(app, name)}/content`)
}

export async function remove(app: App, token: string, t: CloudTarget, name: string, id: string): Promise<void> {
  if (t.provider === 'gdrive') await api(app, token, 'DELETE', `${ep(app).googleApi}/drive/v3/files/${encodeURIComponent(id)}`)
  else await api(app, token, 'DELETE', graphPath(app, name).replace(/:$/, ''))
}

