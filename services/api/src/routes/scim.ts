// SCIM 2.0 provisioning (RFC 7643/7644; admin console phase 5): a directory
// such as Microsoft Entra ID, Okta or JumpCloud keeps this server's accounts
// in step with it, through an admin API token with the "scim" scope.
//
//   base URL   https://<server>/api/scim/v2
//
// Zero knowledge shapes what provisioning can mean. The server cannot make a
// vault (only its owner's master password can), so:
//   create              an invitation is emailed; the user is "active" and
//                       becomes the account once they sign up with it
//   active: false       the account is disabled and signed out everywhere
//   active: true        enabled again
//   delete              offboarded: disabled, signed out, out of every
//                       organization. The vault itself is never deleted by a
//                       directory; staff delete accounts in the console.
// Groups are not provisioned (organization membership needs a fingerprint
// check by the organization's admins).

import { randomBytes } from 'node:crypto'

import type { App } from '../context.js'
import { HttpError, type LambdaEvent, type LambdaResponse } from '../http.js'
import { emailDigest } from '../identity.js'
import { SYSTEM_PK } from '../keys.js'
import { inviteMessage, notify } from '../mail.js'
import { type RegistryEntry, audit, createInvite, deleteInvite, listRegistry } from '../system.js'
import { type ApiToken, authenticateToken, requireScope } from '../apitokens.js'
import { emailOf, offboard, setAccountDisabled } from './admin.js'

const USER = 'urn:ietf:params:scim:schemas:core:2.0:User'
const LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse'
const ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error'
const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp'
const INV = 'SCIMINV#'
const INVITE_DAYS = 30

class ScimError extends Error {
  constructor(readonly status: number, detail: string, readonly scimType?: string) { super(detail) }
}

const scim = (status: number, body: unknown): LambdaResponse => ({
  statusCode: status,
  headers: { 'content-type': 'application/scim+json; charset=utf-8', 'cache-control': 'no-store' },
  body: status === 204 ? '' : JSON.stringify(body),
})

/** Runs a SCIM handler: the token checked, errors in SCIM's shape. */
export function scimRoute(app: App, fn: (token: ApiToken, event: LambdaEvent, params: string[]) => Promise<LambdaResponse>) {
  return Object.assign(async ({ event, params, param }: { event: LambdaEvent; params?: string[]; param?: string }) => {
    try {
      const token = await authenticateToken(app, event)
      requireScope(token, 'scim')
      return await fn(token, event, params ?? (param ? [param] : []))
    } catch (err) {
      if (err instanceof ScimError) return scim(err.status, { schemas: [ERROR], status: String(err.status), detail: err.message, ...(err.scimType ? { scimType: err.scimType } : {}) })
      if (err instanceof HttpError) return scim(err.status, { schemas: [ERROR], status: String(err.status), detail: err.message })
      throw err
    }
  }, { auth: 'access' as const, permission: 'scim' })
}

const actorOf = (t: ApiToken) => `token:${t.id}`
const base = (app: App) => `${app.config.origin}/api/scim/v2`

interface Invited { id: string; email: string; inviteId: string; createdAt: string; externalId?: string }

function accountResource(app: App, r: RegistryEntry, email: string) {
  return {
    schemas: [USER], id: r.userId, userName: email, active: !r.disabled,
    emails: [{ value: email, primary: true, type: 'work' }],
    ...(r.label ? { displayName: r.label } : {}),
    meta: { resourceType: 'User', created: r.createdAt, lastModified: r.lastLoginAt ?? r.createdAt, location: `${base(app)}/Users/${r.userId}` },
  }
}

function invitedResource(app: App, i: Invited) {
  return {
    schemas: [USER], id: i.id, userName: i.email, active: true, ...(i.externalId ? { externalId: i.externalId } : {}),
    emails: [{ value: i.email, primary: true, type: 'work' }],
    meta: { resourceType: 'User', created: i.createdAt, lastModified: i.createdAt, location: `${base(app)}/Users/${i.id}` },
  }
}

/** Every user the directory can see: accounts with an address, and the
 *  invitations it sent that are not accounts yet. */
async function everyone(app: App) {
  const accounts = (await listRegistry(app)).map((r) => ({ r, email: emailOf(app, r) })).filter((x): x is { r: RegistryEntry; email: string } => !!x.email)
  const byEmail = new Set(accounts.map((a) => a.email.toLowerCase()))
  const invited: Invited[] = []
  for (const row of await app.store.query(SYSTEM_PK, INV)) {
    const i = row as unknown as Invited & { pk: string; sk: string }
    // Signed up since: the account stands for them now.
    if (byEmail.has(i.email.toLowerCase())) { await app.store.delete(i.pk, i.sk); continue }
    invited.push(i)
  }
  return { accounts, invited }
}

async function find(app: App, id: string) {
  const { accounts, invited } = await everyone(app)
  const a = accounts.find((x) => x.r.userId === id)
  if (a) return { kind: 'account' as const, a }
  const i = invited.find((x) => x.id === id)
  if (i) return { kind: 'invited' as const, i }
  throw new ScimError(404, `User ${id} not found.`)
}

function body(event: LambdaEvent): Record<string, unknown> {
  try { return event.body ? JSON.parse(event.body) as Record<string, unknown> : {} } catch { throw new ScimError(400, 'The body is not JSON.', 'invalidSyntax') }
}

function emailFrom(b: Record<string, unknown>): string {
  const emails = Array.isArray(b['emails']) ? b['emails'] as { value?: unknown; primary?: unknown }[] : []
  const raw = (emails.find((e) => e.primary === true) ?? emails[0])?.value ?? b['userName']
  const email = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new ScimError(400, 'userName (or a primary email) must be an email address: it is the username here.', 'invalidValue')
  return email
}

// ── Discovery ───────────────────────────────────────────────────────────────

export async function serviceProviderConfig(app: App): Promise<LambdaResponse> {
  return scim(200, {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    documentationUri: `${app.config.origin}/docs`,
    patch: { supported: true }, bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 }, changePassword: { supported: false }, sort: { supported: false }, etag: { supported: false },
    authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Admin API token', description: 'An admin API token with the scim scope, as a bearer token.', primary: true }],
  })
}

export async function resourceTypes(app: App): Promise<LambdaResponse> {
  return scim(200, { schemas: [LIST], totalResults: 1, startIndex: 1, itemsPerPage: 1, Resources: [{ schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'User', name: 'User', endpoint: '/Users', schema: USER, meta: { resourceType: 'ResourceType', location: `${base(app)}/ResourceTypes/User` } }] })
}

export async function schemas(): Promise<LambdaResponse> {
  return scim(200, { schemas: [LIST], totalResults: 1, startIndex: 1, itemsPerPage: 1, Resources: [{ id: USER, name: 'User', description: 'An account on this Vault server; userName is its email address.', attributes: [
    { name: 'userName', type: 'string', required: true, uniqueness: 'server', caseExact: false, mutability: 'immutable' },
    { name: 'active', type: 'boolean', required: false, mutability: 'readWrite' },
    { name: 'emails', type: 'complex', multiValued: true, mutability: 'immutable' },
    { name: 'externalId', type: 'string', mutability: 'readWrite' },
  ] }] })
}

// ── Users ───────────────────────────────────────────────────────────────────

export async function listUsers(app: App, _t: ApiToken, event: LambdaEvent): Promise<LambdaResponse> {
  const q = new URLSearchParams(event.rawQueryString ?? '')
  const startIndex = Math.max(1, Math.floor(Number(q.get('startIndex') ?? 1)) || 1)
  const count = Math.min(200, Math.max(0, Math.floor(Number(q.get('count') ?? 100)) || 0))
  const filter = (q.get('filter') ?? '').trim()
  let match: ((userName: string, externalId?: string) => boolean) | null = null
  if (filter) {
    const m = /^(userName|externalId|emails(?:\.value)?)\s+eq\s+"([^"]*)"$/i.exec(filter)
    if (!m) throw new ScimError(400, 'Only filters of the form userName eq "…", externalId eq "…" or emails eq "…" are supported.', 'invalidFilter')
    const attr = m[1]!.toLowerCase(), value = m[2]!.toLowerCase()
    match = attr === 'externalid' ? (_u, ext) => (ext ?? '').toLowerCase() === value : (u) => u.toLowerCase() === value
  }
  const { accounts, invited } = await everyone(app)
  const all = [
    ...accounts.filter((a) => !match || match(a.email)).map((a) => accountResource(app, a.r, a.email)),
    ...invited.filter((i) => !match || match(i.email, i.externalId)).map((i) => invitedResource(app, i)),
  ]
  const page = all.slice(startIndex - 1, startIndex - 1 + count)
  return scim(200, { schemas: [LIST], totalResults: all.length, startIndex, itemsPerPage: page.length, Resources: page })
}

export async function getUser(app: App, _t: ApiToken, _e: LambdaEvent, [id]: string[]): Promise<LambdaResponse> {
  const f = await find(app, id!)
  return scim(200, f.kind === 'account' ? accountResource(app, f.a.r, f.a.email) : invitedResource(app, f.i))
}

export async function createUser(app: App, token: ApiToken, event: LambdaEvent): Promise<LambdaResponse> {
  const b = body(event)
  const email = emailFrom(b)
  const { accounts, invited } = await everyone(app)
  if (accounts.some((a) => a.email.toLowerCase() === email) || invited.some((i) => i.email === email)) {
    throw new ScimError(409, `A user with userName ${email} already exists.`, 'uniqueness')
  }
  if (b['active'] === false) throw new ScimError(400, 'A new user is created active: it is an invitation to sign up.', 'invalidValue')
  const { code, invite } = await createInvite(app, actorOf(token), email, INVITE_DAYS)
  const i: Invited = { id: `inv_${randomBytes(9).toString('hex')}`, email, inviteId: invite.id, createdAt: new Date(app.now()).toISOString(), ...(typeof b['externalId'] === 'string' ? { externalId: b['externalId'].slice(0, 200) } : {}) }
  await app.store.put({ pk: SYSTEM_PK, sk: `${INV}${emailDigest(email, app.config.pepper)}`, ...i })
  await audit(app, actorOf(token), 'scim.create', undefined, email)
  void notify(app, { to: email, ...inviteMessage(app.config.origin, code, email, invite.expiresAt) })
  return scim(201, invitedResource(app, i))
}

/** The `active` a PATCH or PUT asks for, if it says anything about it. */
function wantedActive(event: LambdaEvent, put: boolean): boolean | undefined {
  const b = body(event)
  if (put) return typeof b['active'] === 'boolean' ? b['active'] : undefined
  if (!Array.isArray(b['schemas']) || !(b['schemas'] as unknown[]).includes(PATCH)) throw new ScimError(400, `A PATCH names the ${PATCH} schema.`, 'invalidSyntax')
  let active: boolean | undefined
  for (const op of (Array.isArray(b['Operations']) ? b['Operations'] : []) as { op?: unknown; path?: unknown; value?: unknown }[]) {
    const kind = String(op.op ?? '').toLowerCase()
    if (kind !== 'replace' && kind !== 'add') continue
    // Entra ID sends "True"/"False" strings; others send booleans or an object.
    const read = (v: unknown) => typeof v === 'boolean' ? v : typeof v === 'string' && /^(true|false)$/i.test(v) ? v.toLowerCase() === 'true' : undefined
    if (typeof op.path === 'string' && op.path.toLowerCase() === 'active') active = read(op.value) ?? active
    else if (!op.path && op.value && typeof op.value === 'object') active = read((op.value as Record<string, unknown>)['active']) ?? active
  }
  return active
}

async function setActive(app: App, token: ApiToken, id: string, active: boolean | undefined): Promise<LambdaResponse> {
  const f = await find(app, id)
  if (f.kind === 'invited') {
    if (active === false) {
      // Not an account yet: withdrawing the invitation is all there is.
      await deleteInvite(app, f.i.inviteId)
      await app.store.delete(SYSTEM_PK, `${INV}${emailDigest(f.i.email, app.config.pepper)}`)
      await audit(app, actorOf(token), 'scim.withdraw', undefined, f.i.email)
      return scim(200, { ...invitedResource(app, f.i), active: false })
    }
    return scim(200, invitedResource(app, f.i))
  }
  if (active !== undefined) await setAccountDisabled(app, actorOf(token), 'admin', f.a.r.userId, !active, 'scim')
  const after = (await find(app, id)) as { kind: 'account'; a: { r: RegistryEntry; email: string } }
  return scim(200, accountResource(app, after.a.r, after.a.email))
}

export const patchUser = (app: App, token: ApiToken, event: LambdaEvent, [id]: string[]) => setActive(app, token, id!, wantedActive(event, false))
export const putUser = (app: App, token: ApiToken, event: LambdaEvent, [id]: string[]) => setActive(app, token, id!, wantedActive(event, true))

export async function deleteUser(app: App, token: ApiToken, _e: LambdaEvent, [id]: string[]): Promise<LambdaResponse> {
  const f = await find(app, id!)
  if (f.kind === 'invited') {
    await deleteInvite(app, f.i.inviteId)
    await app.store.delete(SYSTEM_PK, `${INV}${emailDigest(f.i.email, app.config.pepper)}`)
    await audit(app, actorOf(token), 'scim.withdraw', undefined, f.i.email)
    return scim(204, null)
  }
  // Offboarded, never erased: a directory cannot delete someone's vault.
  if (!f.a.r.disabled) await offboard(app, actorOf(token), 'admin', f.a.r.userId)
  return scim(204, null)
}

export async function groups(): Promise<LambdaResponse> {
  return scim(200, { schemas: [LIST], totalResults: 0, startIndex: 1, itemsPerPage: 0, Resources: [] })
}
