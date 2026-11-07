// Emergency access between people (roadmap phase 3B step 8).
//
// A grantor names a trusted contact and a waiting period. The contact
// accepts; the grantor confirms them by fingerprint and seals their own vault
// key to the contact's public key (context emergency-access:<id>). If the
// contact later requests access, the grantor can approve or reject; if they do
// nothing, access opens when the wait has passed — the point of the feature
// is the case where the grantor cannot answer. Access is read-only: the
// contact is served the grantor's sealed entries and folders, nothing else.
//
// What the server can and cannot do: it holds only a sealed key it cannot
// open, and enforces the wait. A server colluding with the contact could
// release the sealed key early — the same trust any server-enforced delay
// needs — which decisions/0016 records. The vault key never rotates, so
// revoking stops future access but cannot take back a key already opened.

import { randomUUID } from 'node:crypto'

import type { App } from '../context.js'
import { HttpError, type LambdaEvent, type LambdaResponse, badRequest, conflict, json, notFound, parseJsonBody } from '../http.js'
import { emailDigest } from '../identity.js'
import {
  EMERGENCY_INVITE_PREFIX, EMERGENCY_PREFIX, EMERGENCY_TRUST_PREFIX, ENTRY_PREFIX, FOLDER_PREFIX, PROFILE_SK,
  emailPk, emergencyInviteSk, emergencySk, emergencyTrustSk, isValidId, userPk,
} from '../keys.js'
import type { Item } from '../store.js'
import { requireEmail, requireSharedKey } from '../validate.js'
import { recordActivity } from './activity.js'

type Status = 'invited' | 'accepted' | 'confirmed' | 'requested' | 'approved' | 'rejected'

interface Grant extends Item {
  id: string
  grantorId: string
  granteeDigest: string
  granteeId?: string
  granteePublicKey?: string
  /** What the contact is called, for the grantor. */
  label: string
  /** What the grantor is called, for the contact (typed by the grantor). */
  fromName: string
  waitDays: number
  status: Status
  keyBlob?: string
  requestedAt?: string
  createdAt: string
}

const body = (e: LambdaEvent) => parseJsonBody<Record<string, unknown>>(e)
const text = (v: unknown, field: string, max = 80) => {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > max) throw badRequest(`${field} is required, at most ${max} characters.`)
  return v.trim()
}

async function profile(app: App, userId: string) {
  const p = await app.store.get(userPk(userId), PROFILE_SK)
  if (!p) throw notFound()
  return p
}

async function grantFor(app: App, grantorId: string, id: string): Promise<Grant> {
  if (!isValidId(id) || !isValidId(grantorId)) throw notFound()
  const g = (await app.store.get(userPk(grantorId), emergencySk(id))) as Grant | null
  if (!g) throw notFound()
  return g
}

/** The grant as the contact may see it: from their pointer, never by guessing. */
async function asGrantee(app: App, userId: string, id: string): Promise<Grant> {
  if (!isValidId(id)) throw notFound()
  const ptr = await app.store.get(userPk(userId), emergencyTrustSk(id))
  if (!ptr) throw notFound()
  const g = await grantFor(app, String(ptr['grantorId']), id)
  if (g.granteeId !== userId) throw notFound()
  return g
}

const opensAt = (g: Grant) => g.requestedAt ? new Date(Date.parse(g.requestedAt) + g.waitDays * 86_400_000).toISOString() : null
const isOpen = (app: App, g: Grant) => g.status === 'approved' || (g.status === 'requested' && Date.parse(opensAt(g)!) <= app.now())

const forGrantor = (app: App, g: Grant) => ({
  id: g.id, label: g.label, waitDays: g.waitDays, status: isOpen(app, g) && g.status === 'requested' ? 'approved' : g.status,
  granteePublicKey: g.status === 'accepted' ? g.granteePublicKey ?? null : null, requestedAt: g.requestedAt ?? null, opensAt: opensAt(g),
})
const forGrantee = (app: App, g: Grant) => ({
  id: g.id, fromName: g.fromName, waitDays: g.waitDays, status: isOpen(app, g) ? 'approved' : g.status,
  requestedAt: g.requestedAt ?? null, opensAt: opensAt(g),
})

// ── Grantor ───────────────────────────────────────────────────────────────

export async function create(app: App, userId: string, event: LambdaEvent): Promise<LambdaResponse> {
  const b = body(event)
  const email = requireEmail(b['email'])
  const waitDays = Number(b['waitDays'])
  if (!Number.isInteger(waitDays) || waitDays < 1 || waitDays > 30) throw badRequest('waitDays must be 1 to 30.')
  const me = await profile(app, userId)
  const digest = emailDigest(email, app.config.pepper)
  if (digest === me['emailDigest']) throw badRequest('Choose someone other than yourself.')
  const id = randomUUID()
  const g: Grant = {
    pk: userPk(userId), sk: emergencySk(id), id, grantorId: userId, granteeDigest: digest,
    label: text(b['label'] ?? email.split('@')[0], 'label'), fromName: text(b['fromName'], 'fromName'),
    waitDays, status: 'invited', createdAt: new Date(app.now()).toISOString(),
  }
  await app.store.put(g)
  // Waits for the contact whether or not they have an account yet (A7).
  await app.store.put({ pk: emailPk(digest), sk: emergencyInviteSk(id), id, grantorId: userId })
  return json(201, { id })
}

export async function mine(app: App, userId: string): Promise<LambdaResponse> {
  const grants = (await app.store.query(userPk(userId), EMERGENCY_PREFIX)) as Grant[]
  return json(200, { grants: grants.map((g) => forGrantor(app, g)) })
}

export async function confirm(app: App, userId: string, event: LambdaEvent, id: string): Promise<LambdaResponse> {
  const g = await grantFor(app, userId, id)
  if (g.status !== 'accepted' || !g.granteeId) throw conflict('Only an accepted contact can be confirmed.')
  const keyBlob = requireSharedKey(body(event)['keyBlob'], 'keyBlob')
  const current = (await profile(app, g.granteeId))['publicKey']
  if (current !== g.granteePublicKey) throw conflict('Their identity key changed after they accepted. Remove them and add them again.')
  await app.store.put({ ...g, status: 'confirmed', keyBlob })
  return json(200, { ok: true })
}

export async function decide(app: App, userId: string, id: string, approve: boolean): Promise<LambdaResponse> {
  const g = await grantFor(app, userId, id)
  if (g.status !== 'requested') throw conflict('There is no pending request.')
  await app.store.put({ ...g, status: approve ? 'approved' : 'rejected' })
  return json(200, { ok: true })
}

export async function revoke(app: App, userId: string, id: string): Promise<LambdaResponse> {
  const g = await grantFor(app, userId, id)
  await app.store.delete(g.pk, g.sk)
  await app.store.delete(emailPk(g.granteeDigest), emergencyInviteSk(id))
  if (g.granteeId) await app.store.delete(userPk(g.granteeId), emergencyTrustSk(id))
  return json(200, { ok: true })
}

// ── Grantee ───────────────────────────────────────────────────────────────

export async function trusted(app: App, userId: string): Promise<LambdaResponse> {
  const me = await profile(app, userId)
  const invites = await app.store.query(emailPk(String(me['emailDigest'])), EMERGENCY_INVITE_PREFIX)
  const pending = []
  for (const i of invites) {
    const g = (await app.store.get(userPk(String(i['grantorId'])), emergencySk(String(i['id'])))) as Grant | null
    if (g) pending.push({ id: g.id, fromName: g.fromName, waitDays: g.waitDays })
  }
  const ptrs = await app.store.query(userPk(userId), EMERGENCY_TRUST_PREFIX)
  const held = []
  for (const p of ptrs) {
    const g = (await app.store.get(userPk(String(p['grantorId'])), emergencySk(String(p['id'])))) as Grant | null
    if (g && g.granteeId === userId) held.push(forGrantee(app, g))
  }
  return json(200, { invitations: pending, grants: held })
}

export async function accept(app: App, userId: string, id: string): Promise<LambdaResponse> {
  const me = await profile(app, userId)
  if (!isValidId(id)) throw notFound()
  const inv = await app.store.get(emailPk(String(me['emailDigest'])), emergencyInviteSk(id))
  if (!inv) throw notFound()
  if (typeof me['publicKey'] !== 'string') throw new HttpError(409, 'conflict', 'Your identity key is created on your next unlock.')
  const g = await grantFor(app, String(inv['grantorId']), id)
  await app.store.put({ ...g, status: 'accepted', granteeId: userId, granteePublicKey: me['publicKey'] })
  await app.store.put({ pk: userPk(userId), sk: emergencyTrustSk(id), id, grantorId: g.grantorId })
  await app.store.delete(inv.pk, inv.sk)
  return json(200, { ok: true })
}

export async function request(app: App, userId: string, event: LambdaEvent, id: string): Promise<LambdaResponse> {
  const g = await asGrantee(app, userId, id)
  if (g.status !== 'confirmed' && g.status !== 'rejected') throw conflict(g.status === 'requested' || g.status === 'approved' ? 'Already requested.' : 'They have not confirmed you yet.')
  await app.store.put({ ...g, status: 'requested', requestedAt: new Date(app.now()).toISOString() })
  await recordActivity(app, g.grantorId, 'emergency-request', event)
  return json(200, { ok: true, opensAt: new Date(app.now() + g.waitDays * 86_400_000).toISOString() })
}

/** The grantor's sealed vault, read-only, once access is open. */
export async function vault(app: App, userId: string, event: LambdaEvent, id: string): Promise<LambdaResponse> {
  const g = await asGrantee(app, userId, id)
  if (!isOpen(app, g) || !g.keyBlob) throw new HttpError(403, 'forbidden', g.status === 'requested' ? `Access opens ${opensAt(g)} unless they reject it.` : 'Access is not open.')
  await recordActivity(app, g.grantorId, 'emergency-access', event)
  const rows = await app.store.query(userPk(g.grantorId))
  const pick = (prefix: string) => rows.filter((r) => r.sk.startsWith(prefix)).map((r) => ({ id: r['id'], blob: r['blob'] }))
  return json(200, { keyBlob: g.keyBlob, entries: pick(ENTRY_PREFIX), folders: pick(FOLDER_PREFIX) })
}

