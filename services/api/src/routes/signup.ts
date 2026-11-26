// An account first, a vault later (decisions/0037).
//
//   POST /api/auth/account/signup          email → a 6-digit code by email
//   POST /api/auth/account/signup/verify   email + code + account password →
//                                          an account (no vault yet), signed in
//   POST /api/auth/vault/request           ask the operator for a vault
//   admin: list, approve (the person is emailed), decline
//
// The vault itself is created with POST /api/auth/register and the account
// token: open registration, an invitation code or an approval lets it through,
// as the server's registration setting says.
//
// An account without a vault is two rows: its data under its user id, and a
// pointer from its address. It is not in the registry (it is not a user of
// this server's vaults yet), and no other route sees it.

import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'

import type { App } from '../context.js'
import { HttpError, type LambdaEvent, type LambdaResponse, json, notFound, parseJsonBody, unauthorized } from '../http.js'
import { emailDigest, openEmail, sealEmail } from '../identity.js'
import { EMAIL_SK, SYSTEM_PK, emailPk, userPk } from '../keys.js'
import { alreadyRegisteredMessage, notify, verifyMessage, vaultApprovedMessage } from '../mail.js'
import { featuresOf } from '../edition.js'
import { audit, getSettings, listRegistry } from '../system.js'
import { verifyToken } from '../tokens.js'
import { requireEmail } from '../validate.js'
import { hashAuthKey } from '../verifier.js'
import { type AccountPassword, issueAccountToken, requireAccountInput } from './accounts.js'
import { enforce } from '../ratelimit.js'
import { companyForEmail } from './tenants.js'

const PENDING_SK = 'PENDING'
const ACCOUNT_SK = 'ACCOUNT'
const SIGNUP_SK = 'SIGNUP'
const REQUEST_PREFIX = 'VREQ#'
const CODE_MINUTES = 10
const MAX_TRIES = 5

export interface PendingAccount {
  userId: string
  emailDigest: string
  emailSealed: string
  account: AccountPassword
  createdAt: string
  /** An administrator approved a vault for this account. */
  approved?: boolean
  requestedAt?: string
  note?: string
}

const hash = (s: string) => createHash('sha256').update(s).digest()

/** Mail sent on request (codes, reset links): per network address, and per
 *  inbox so one address cannot be flooded. Not the sign-in limit. */
export const MAIL_LIMIT = { max: 20, windowSeconds: 15 * 60 }
export async function limitMail(app: App, event: LambdaEvent, email: string): Promise<void> {
  await enforce(app.store, 'mail-ip', event.requestContext.http.sourceIp, MAIL_LIMIT, app.now())
  await enforce(app.store, 'mail-email', emailDigest(email, app.config.pepper), { max: 5, windowSeconds: 15 * 60 }, app.now())
}

/** The account without a vault behind an address, if there is one. */
export async function pendingByEmail(app: App, email: string): Promise<PendingAccount | null> {
  const ptr = await app.store.get(emailPk(emailDigest(email, app.config.pepper)), ACCOUNT_SK)
  return ptr ? pendingById(app, String(ptr['userId'])) : null
}

export async function pendingById(app: App, userId: string): Promise<PendingAccount | null> {
  const row = await app.store.get(userPk(userId), PENDING_SK)
  if (!row) return null
  const { pk: _p, sk: _s, ...rest } = row
  return rest as unknown as PendingAccount
}

export async function savePending(app: App, p: PendingAccount): Promise<void> {
  await app.store.put({ pk: userPk(p.userId), sk: PENDING_SK, ...p })
}

/** The account now has a vault (or is gone): its pending rows go. */
export async function dropPending(app: App, p: PendingAccount): Promise<void> {
  await app.store.delete(userPk(p.userId), PENDING_SK)
  await app.store.delete(emailPk(p.emailDigest), ACCOUNT_SK)
  await app.store.delete(SYSTEM_PK, `${REQUEST_PREFIX}${p.userId}`)
}

/** What the apps need to know about an account that has no vault. */
export const pendingStatus = (p: PendingAccount) => ({ vault: false, approved: p.approved === true, requested: !!p.requestedAt })

// ── Sign up ───────────────────────────────────────────────────────────────

/** Always the same answer, so it says nothing about the address. An address
 *  that already has an account is told so by email instead of getting a code. */
export async function signup(app: App, event: LambdaEvent): Promise<LambdaResponse> {
  const email = requireEmail(parseJsonBody<{ email?: unknown }>(event).email)
  // Its own per-address bucket (a flood of codes to one inbox), apart from the
  // sign-in limit that guards passwords.
  await limitMail(app, event, email)
  if (!app.mailer) throw new HttpError(503, 'unavailable', 'This server does not send email, so accounts are created with an invitation. Ask the person who runs it.')
  if (app.config.edition === 'personal' && (await listRegistry(app)).length > 0) {
    throw new HttpError(403, 'forbidden', 'This is a personal Vault: it has one account, and no one else can join.')
  }
  const digest = emailDigest(email, app.config.pepper)
  const exists = (await app.store.get(emailPk(digest), EMAIL_SK)) || (await app.store.get(emailPk(digest), ACCOUNT_SK))
  if (exists) {
    void notify(app, { to: email, ...alreadyRegisteredMessage(app.config.origin) })
  } else {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    await app.store.put({ pk: emailPk(digest), sk: SIGNUP_SK, codeHash: hash(`${digest}|${code}`).toString('base64url'), tries: 0, expiresAt: Math.floor(app.now() / 1000) + CODE_MINUTES * 60 })
    void notify(app, { to: email, ...verifyMessage(app.config.origin, code) })
  }
  return json(200, { ok: true })
}

export async function verify(app: App, event: LambdaEvent): Promise<LambdaResponse> {
  const body = parseJsonBody<Record<string, unknown>>(event)
  const email = requireEmail(body['email'])
  // Each code allows five tries; per network address as well.
  await enforce(app.store, 'mail-ip', event.requestContext.http.sourceIp, MAIL_LIMIT, app.now())
  const code = typeof body['code'] === 'string' ? body['code'].replace(/\s+/g, '') : ''
  const input = requireAccountInput(body['account'])
  const digest = emailDigest(email, app.config.pepper)
  const row = await app.store.get(emailPk(digest), SIGNUP_SK)
  const wrong = () => new HttpError(400, 'bad_request', 'That code is wrong or has expired. Ask for a new one.')
  if (!row || Number(row['expiresAt']) < Math.floor(app.now() / 1000) || Number(row['tries']) >= MAX_TRIES) throw wrong()
  const expected = Buffer.from(String(row['codeHash']), 'base64url')
  const given = hash(`${digest}|${code}`)
  if (!/^\d{6}$/.test(code) || !timingSafeEqual(expected, given)) {
    await app.store.put({ ...row, tries: Number(row['tries']) + 1 })
    throw wrong()
  }
  await app.store.delete(row.pk, row.sk)
  const userId = randomUUID()
  // The pointer first, with a condition: two sign-ups for one address lose in
  // the database. An address that has a vault account already is refused too.
  if (await app.store.get(emailPk(digest), EMAIL_SK)) throw wrong()
  try {
    await app.store.put({ pk: emailPk(digest), sk: ACCOUNT_SK, userId }, { mustNotExist: true })
  } catch { throw wrong() }
  const at = new Date(app.now()).toISOString()
  const pending: PendingAccount = {
    userId, emailDigest: digest, emailSealed: sealEmail(app.config.pepper, email), createdAt: at,
    account: { salt: input.salt, m: input.m, t: input.t, p: input.p, verifier: await hashAuthKey(input.proof), setAt: at },
  }
  await savePending(app, pending)
  return json(201, { accountToken: await issueAccountToken(app, userId, event), ...pendingStatus(pending), registration: await registrationMode(app) })
}

async function registrationMode(app: App): Promise<string> {
  return app.allowRegistration ? 'open' : (await getSettings(app)).registration
}

// ── Asking for a vault ────────────────────────────────────────────────────

async function pendingFromToken(app: App, token: unknown): Promise<PendingAccount> {
  const payload = typeof token === 'string' ? verifyToken(token, 'account', app.config.tokenKey, app.now()) : null
  if (!payload?.jti || !(await app.store.get(userPk(payload.sub), `ACCTSESS#${payload.jti}`))) throw unauthorized()
  const p = await pendingById(app, payload.sub)
  if (!p) throw new HttpError(409, 'conflict', 'This account already has a vault.')
  return p
}

export async function requestVault(app: App, event: LambdaEvent): Promise<LambdaResponse> {
  const body = parseJsonBody<{ accountToken?: unknown; note?: unknown }>(event)
  const p = await pendingFromToken(app, body.accountToken)
  if (!featuresOf(app.config.edition).invitations) throw new HttpError(403, 'forbidden', 'This server takes no requests.')
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : ''
  if (p.requestedAt) return json(200, { ok: true, already: true })
  const at = new Date(app.now()).toISOString()
  // An address at a domain a company verified (admin console phase 4) is
  // approved at once: that company vouches for its domain.
  let email = ''
  try { email = openEmail(app.config.pepper, p.emailSealed) } catch { /* unreadable */ }
  const company = email ? await companyForEmail(app, email) : null
  if (company) {
    await savePending(app, { ...p, approved: true, requestedAt: at, ...(note ? { note } : {}) })
    await audit(app, 'system', 'vault-request.auto-approve', p.userId, email.split('@')[1])
    void notify(app, { to: email, ...vaultApprovedMessage(app.config.origin) })
    return json(200, { ok: true, approved: true })
  }
  await savePending(app, { ...p, requestedAt: at, ...(note ? { note } : {}) })
  await app.store.put({ pk: SYSTEM_PK, sk: `${REQUEST_PREFIX}${p.userId}`, userId: p.userId, at })
  return json(200, { ok: true })
}

/** What the sign-in screen shows for an account without a vault. */
export async function status(app: App, event: LambdaEvent): Promise<LambdaResponse> {
  const p = await pendingFromToken(app, parseJsonBody<{ accountToken?: unknown }>(event).accountToken)
  return json(200, { ...pendingStatus(p), registration: await registrationMode(app) })
}

// ── For administrators ────────────────────────────────────────────────────

export async function listRequests(app: App): Promise<LambdaResponse> {
  const rows = await app.store.query(SYSTEM_PK, REQUEST_PREFIX)
  const out = []
  for (const r of rows) {
    const p = await pendingById(app, String(r['userId']))
    if (!p) { await app.store.delete(r.pk, r.sk); continue }
    let email = ''
    try { email = openEmail(app.config.pepper, p.emailSealed) } catch { /* unreadable */ }
    out.push({ userId: p.userId, email, note: p.note ?? '', requestedAt: p.requestedAt ?? String(r['at']), createdAt: p.createdAt })
  }
  out.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
  return json(200, { requests: out })
}

export async function decide(app: App, actor: string, id: string, approve: boolean): Promise<LambdaResponse> {
  const p = await pendingById(app, id)
  if (!p || !p.requestedAt) throw notFound()
  await app.store.delete(SYSTEM_PK, `${REQUEST_PREFIX}${id}`)
  if (approve) {
    await savePending(app, { ...p, approved: true })
    let email = ''
    try { email = openEmail(app.config.pepper, p.emailSealed) } catch { /* no mail then */ }
    if (email) void notify(app, { to: email, ...vaultApprovedMessage(app.config.origin) })
    await audit(app, actor, 'vault-request.approve', id, email || undefined)
  } else {
    const { requestedAt: _r, note: _n, ...rest } = p
    await savePending(app, rest as PendingAccount)
    await audit(app, actor, 'vault-request.decline', id)
  }
  return json(200, { ok: true })
}


/** For creating the vault: the account without one that this token and
 *  address belong to. */
export async function pendingForVault(app: App, token: unknown, email: string): Promise<PendingAccount> {
  const p = await pendingFromToken(app, token)
  if (p.emailDigest !== emailDigest(email, app.config.pepper)) throw unauthorized()
  return p
}
