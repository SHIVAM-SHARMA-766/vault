// Signing in in two steps (decisions/0036): the account first, then the vault.
//
//   1. POST /api/auth/account/prelogin   the account password's salt (a decoy for
//                                        an unknown address)
//   2. POST /api/auth/account/login      email + account proof (+ second factor,
//                                        + SSO ticket): an account token
//   3. POST /api/auth/unlock             account token + master password proof:
//                                        a vault session and the wrapped vault key
//
// The account token is long-lived and kept by the browser, so day to day only
// the master password is typed. It is good for nothing but step 3: it is not
// an access token, and it never yields the wrapped vault key without the
// master password's proof. Each of the two secrets is needed; neither is
// enough alone.

import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'

import type { App } from '../context.js'
import { describeDevice } from '../device.js'
import { HttpError, type LambdaEvent, type LambdaResponse, badRequest, invalidCredentials, json, notFound, parseJsonBody, unauthorized } from '../http.js'
import { PROFILE_SK, userPk } from '../keys.js'
import { accountResetMessage, notify } from '../mail.js'
import { assertNetwork } from '../networks.js'
import { AUTH_LIMIT, enforce } from '../ratelimit.js'
import { assertEnabled, touchLogin } from '../system.js'
import { issueToken, verifyToken } from '../tokens.js'
import { requireBase64UrlBytes, requireEmail } from '../validate.js'
import { hashAuthKey, verifyAuthKey } from '../verifier.js'
import { recordActivity } from './activity.js'
import {
  DUMMY_VERIFIER, type Profile, issueSession, limitAuth, profileByEmail, requireSecondFactor, revokeAllSessions,
  sendSignInNotice, sessionDeadline,
} from './auth.js'
import { readTicket, ssoGate, useTicket } from './sso.js'

export interface AccountPassword { salt: string; m: number; t: number; p: number; verifier: string; setAt: string }
type WithAccount = Profile & { account?: AccountPassword }

const ACCT_PREFIX = 'ACCTSESS#'
const ACCOUNT_DAYS = 30
const RESET_MINUTES = 30
const DEFAULT = { m: 19_456, t: 2, p: 1 }

/** The account password's settings, as a client sends them: Argon2id within
 *  limits, a 16-byte salt, and the proof derived with them. */
export function requireAccountInput(v: unknown): { salt: string; m: number; t: number; p: number; proof: string } {
  const a = v as Record<string, unknown> | null
  if (!a || typeof a !== 'object') throw badRequest('account is required.')
  const salt = requireBase64UrlBytes(a['salt'], 16, 'account.salt')
  const [m, t, p] = [a['m'], a['t'], a['p']].map(Number)
  if (![m, t, p].every(Number.isInteger) || m! < 19_456 || m! > 262_144 || t! < 1 || t! > 10 || p! < 1 || p! > 4 || m! * t! < 38_912) {
    throw badRequest('account Argon2id settings are out of range.')
  }
  return { salt, m: m!, t: t!, p: p!, proof: requireBase64UrlBytes(a['proof'], 32, 'account.proof') }
}

/** The app also derives, from the new account password, the auth key the
 *  master password would give (`masterCheck`). If it verifies, the two
 *  passwords are the same text, which is refused: one leaked password must
 *  not be both. The value tells the server nothing it could not already try. */
async function refuseSameAsMaster(body: Record<string, unknown>, profile: Profile): Promise<void> {
  if (body['masterCheck'] === undefined) return
  const check = requireBase64UrlBytes(body['masterCheck'], 32, 'masterCheck')
  if (await verifyAuthKey(check, profile.authVerifier)) throw badRequest('The account password must differ from the master password.')
}

async function storedAccount(input: ReturnType<typeof requireAccountInput>, now: number): Promise<AccountPassword> {
  return { salt: input.salt, m: input.m, t: input.t, p: input.p, verifier: await hashAuthKey(input.proof), setAt: new Date(now).toISOString() }
}

/** A long-lived account sign-in, recorded per device so it can be revoked. */
export async function issueAccountToken(app: App, userId: string, event: LambdaEvent, createdAt?: string): Promise<string> {
  const jti = randomUUID()
  const now = new Date(app.now()).toISOString()
  const deadline = await sessionDeadline(app, createdAt ?? now)
  const sliding = Math.floor(app.now() / 1000) + ACCOUNT_DAYS * 86_400
  const exp = deadline !== undefined ? Math.min(sliding, deadline) : sliding
  await app.store.put({
    pk: userPk(userId), sk: `${ACCT_PREFIX}${jti}`, createdAt: createdAt ?? now, lastUsedAt: now, expiresAt: exp,
    device: describeDevice(event.requestContext.http.userAgent), ip: event.requestContext.http.sourceIp,
  })
  return issueToken({ sub: userId, typ: 'account', exp, jti }, app.config.tokenKey)
}

/** The account token's record, used up: a new one replaces it each time. A
 *  token that verifies but has no record was already used: someone holds a
 *  copy, so every sign-in of this account ends. */
async function takeAccountToken(app: App, token: unknown): Promise<{ userId: string; createdAt: string }> {
  if (typeof token !== 'string') throw unauthorized()
  const payload = verifyToken(token, 'account', app.config.tokenKey, app.now())
  if (!payload?.jti) throw unauthorized()
  const row = await app.store.get(userPk(payload.sub), `${ACCT_PREFIX}${payload.jti}`)
  if (!row) { await revokeAllSessions(app, payload.sub); throw unauthorized() }
  await app.store.delete(row.pk, row.sk)
  return { userId: payload.sub, createdAt: String(row['createdAt']) }
}

// ── Step 1: the account password's settings ───────────────────────────────

export async function prelogin(app: App, event: LambdaEvent): Promise<LambdaResponse> {
  const email = requireEmail(parseJsonBody<{ email?: unknown }>(event).email)
  // Per address only: it checks no secret, and its decoys say nothing. The
  // per-account limit counts what guesses a password: login and unlock.
  await enforce(app.store, 'auth-ip', event.requestContext.http.sourceIp, AUTH_LIMIT, app.now())
  const profile = (await profileByEmail(app, email)) as WithAccount | null
  if (profile?.account) {
    const { salt, m, t, p } = profile.account
    return json(200, { account: { salt, m, t, p } })
  }
  // An unknown address, and an account that has not set one yet, get the same
  // stable decoy, so this answer says nothing about either.
  const salt = createHmac('sha256', app.config.pepper).update(`account-salt-decoy|${email.trim().toLowerCase()}`).digest().subarray(0, 16).toString('base64url')
  return json(200, { account: { salt, ...DEFAULT } })
}

// ── Step 2: the account ───────────────────────────────────────────────────

export async function login(app: App, event: LambdaEvent): Promise<LambdaResponse> {
  const body = parseJsonBody<Record<string, unknown>>(event)
  const email = requireEmail(body['email'])
  await limitAuth(app, event, email)
  const profile = (await profileByEmail(app, email)) as WithAccount | null
  // With a single sign-on ticket for this account, the identity provider has
  // done the account step (decisions/0021, 0036); otherwise the account password.
  const viaSso = body['accountProof'] === undefined && body['ssoTicket'] !== undefined
  if (viaSso) {
    if (!profile || (await readTicket(app, body['ssoTicket']))?.userId !== profile.userId) throw new HttpError(401, 'sso_invalid', 'That single sign-on has expired or is for another account. Sign in again.')
  } else {
    const proof = requireBase64UrlBytes(body['accountProof'], 32, 'accountProof')
    // As with the master password: an unknown address costs the same work.
    const ok = await verifyAuthKey(proof, profile?.account?.verifier ?? DUMMY_VERIFIER)
    if (!ok || !profile?.account) throw invalidCredentials()
  }
  await assertNetwork(app, profile.userId, event.requestContext.http.sourceIp)
  await assertEnabled(app, profile.userId)
  const sso = await ssoGate(app, profile, body['ssoTicket'])
  await requireSecondFactor(app, profile, body, event)
  if (sso && !(await useTicket(app, sso))) throw new HttpError(401, 'sso_invalid', 'That single sign-on was already used. Sign in again.')
  await touchLogin(app, profile.userId, profile)
  if (app.config.mail.signInNotices && profile['signInAlerts'] !== false) sendSignInNotice(app, email, event, false)
  await recordActivity(app, profile.userId, sso ? 'sso-login' : 'login', event)
  return json(200, { accountToken: await issueAccountToken(app, profile.userId, event), kdf: profile.kdf })
}

/** Is this account sign-in still good, and what does the master password
 *  need? Only looks: the token is replaced at unlock, so a check and an
 *  unlock sent together cannot look like a stolen copy. */
export async function session(app: App, event: LambdaEvent): Promise<LambdaResponse> {
  const token = parseJsonBody<{ accountToken?: unknown }>(event).accountToken
  const payload = typeof token === 'string' ? verifyToken(token, 'account', app.config.tokenKey, app.now()) : null
  if (!payload?.jti || !(await app.store.get(userPk(payload.sub), `${ACCT_PREFIX}${payload.jti}`))) throw unauthorized()
  await assertEnabled(app, payload.sub)
  await assertNetwork(app, payload.sub, event.requestContext.http.sourceIp)
  const profile = (await app.store.get(userPk(payload.sub), PROFILE_SK)) as WithAccount | null
  if (!profile) throw unauthorized()
  return json(200, { kdf: profile.kdf })
}

// ── Step 3: the vault ─────────────────────────────────────────────────────

export async function unlock(app: App, event: LambdaEvent): Promise<LambdaResponse> {
  const body = parseJsonBody<Record<string, unknown>>(event)
  // Counted per account (below): it needs a valid account sign-in first, so
  // the master password cannot be guessed here by anyone without one.
  const authKey = requireBase64UrlBytes(body['authKey'], 32, 'authKey')
  const { userId, createdAt } = await takeAccountToken(app, body['accountToken'])
  const profile = (await app.store.get(userPk(userId), PROFILE_SK)) as WithAccount | null
  if (!profile) throw unauthorized()
  await enforce(app.store, 'auth-email', profile.emailDigest, AUTH_LIMIT, app.now())
  await assertEnabled(app, userId)
  await assertNetwork(app, userId, event.requestContext.http.sourceIp)
  // A session policy can end this device's account sign-in at a fixed time.
  const deadline = await sessionDeadline(app, createdAt)
  if (deadline !== undefined && deadline <= Math.floor(app.now() / 1000)) throw unauthorized()
  const accountToken = await issueAccountToken(app, userId, event, createdAt)
  if (!(await verifyAuthKey(authKey, profile.authVerifier))) {
    // A wrong master password keeps the account sign-in; the limits above count it.
    return json(401, { error: 'invalid_credentials', message: 'That master password is not right.', accountToken })
  }
  await recordActivity(app, userId, 'unlock', event)
  return json(200, { accountToken, wrappedVaultKey: profile.wrappedVaultKey, kdf: profile.kdf, ...(await issueSession(app, userId, event)) })
}

export async function signOut(app: App, event: LambdaEvent): Promise<LambdaResponse> {
  const token = parseJsonBody<{ accountToken?: unknown }>(event).accountToken
  const payload = typeof token === 'string' ? verifyToken(token, 'account', app.config.tokenKey, app.now()) : null
  if (payload?.jti) await app.store.delete(userPk(payload.sub), `${ACCT_PREFIX}${payload.jti}`)
  return json(200, { ok: true })
}

// ── Setting and changing it ───────────────────────────────────────────────

/** First time (after a sign-in with the master password): the session is
 *  enough. A change needs the current account password. */
export async function setPassword(app: App, userId: string, event: LambdaEvent): Promise<LambdaResponse> {
  const body = parseJsonBody<Record<string, unknown>>(event)
  const input = requireAccountInput(body['account'])
  const profile = (await app.store.get(userPk(userId), PROFILE_SK)) as WithAccount | null
  if (!profile) throw unauthorized()
  if (profile.account) {
    const current = requireBase64UrlBytes(body['currentAccountProof'], 32, 'currentAccountProof')
    if (!(await verifyAuthKey(current, profile.account.verifier))) throw invalidCredentials()
  }
  await refuseSameAsMaster(body, profile)
  const first = !profile.account
  await app.store.put({ ...profile, account: await storedAccount(input, app.now()), updatedAt: new Date(app.now()).toISOString() })
  if (!first) for (const s of await app.store.query(userPk(userId), ACCT_PREFIX)) await app.store.delete(s.pk, s.sk)
  await recordActivity(app, userId, first ? 'set-account-password' : 'change-account-password', event)
  return json(200, { accountToken: await issueAccountToken(app, userId, event) })
}

// ── Forgotten: a link by email ────────────────────────────────────────────

const resetSk = (code: string) => `ACCTRESET#${createHash('sha256').update(code).digest('base64url')}`

/** Always the same answer, so it says nothing about the address. */
export async function forgot(app: App, event: LambdaEvent): Promise<LambdaResponse> {
  const email = requireEmail(parseJsonBody<{ email?: unknown }>(event).email)
  await limitAuth(app, event, email)
  const profile = (await profileByEmail(app, email)) as WithAccount | null
  if (profile?.account && app.mailer) {
    const code = randomBytes(24).toString('base64url')
    await app.store.put({ pk: userPk(profile.userId), sk: resetSk(code), expiresAt: Math.floor(app.now() / 1000) + RESET_MINUTES * 60 })
    void notify(app, { to: email, ...accountResetMessage(app.config.origin, email, code) })
  }
  return json(200, { ok: true, mail: Boolean(app.mailer) })
}

export async function reset(app: App, event: LambdaEvent): Promise<LambdaResponse> {
  const body = parseJsonBody<Record<string, unknown>>(event)
  const email = requireEmail(body['email'])
  await limitAuth(app, event, email)
  const code = typeof body['code'] === 'string' && body['code'].length <= 64 ? body['code'] : ''
  const input = requireAccountInput(body['account'])
  const profile = (await profileByEmail(app, email)) as WithAccount | null
  const row = profile && code ? await app.store.get(userPk(profile.userId), resetSk(code)) : null
  if (!profile || !row || Number(row['expiresAt']) < Math.floor(app.now() / 1000)) {
    throw new HttpError(400, 'bad_request', 'That reset link has expired or was already used. Ask for a new one.')
  }
  await app.store.delete(row.pk, row.sk)
  await refuseSameAsMaster(body, profile)
  await app.store.put({ ...profile, account: await storedAccount(input, app.now()), updatedAt: new Date(app.now()).toISOString() })
  await revokeAllSessions(app, profile.userId)
  await recordActivity(app, profile.userId, 'reset-account-password', event)
  return json(200, { ok: true })
}

/** An administrator clears someone's account password (no mail on the
 *  server, say). They then sign in once with the master password and choose
 *  a new one. Audited by the caller. */
export async function clearPassword(app: App, userId: string): Promise<void> {
  const profile = (await app.store.get(userPk(userId), PROFILE_SK)) as WithAccount | null
  if (!profile) throw notFound()
  const { account: _a, ...rest } = profile
  await app.store.put({ ...rest, updatedAt: new Date(app.now()).toISOString() } as Profile)
  for (const s of await app.store.query(userPk(userId), ACCT_PREFIX)) await app.store.delete(s.pk, s.sk)
}

/** What /api/auth/me says about it. */
export const accountStatus = (profile: unknown) => {
  const a = (profile as WithAccount).account
  return a ? { set: true, setAt: a.setAt } : { set: false }
}

/** At registration: the account password chosen with the master password. */
export async function registerAccount(app: App, userId: string, input: ReturnType<typeof requireAccountInput>, event: LambdaEvent): Promise<{ account: AccountPassword; accountToken: string }> {
  return { account: await storedAccount(input, app.now()), accountToken: await issueAccountToken(app, userId, event) }
}

