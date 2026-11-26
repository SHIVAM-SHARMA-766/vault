// Unlock with a passkey (decisions/0022 (b), 0034). A passkey made for this
// stands in for the master password *and* the second factor: it is something
// held (the authenticator) and something known or owned (its PIN or
// biometric, required here as user verification), and it only answers this
// server's address. The server checks the WebAuthn signature and hands back
// the vault key as the browser wrapped it under the passkey's PRF output,
// which the server never sees. Without the authenticator, the blob is noise.
//
// Sign-in uses discoverable credentials: the browser lists the passkeys it
// has for this site, so nothing typed tells the server which account is
// trying, and an unknown address cannot be probed.

import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type AuthenticatorTransport, type RegistrationResponseJSON,
} from '@simplewebauthn/server'

import type { App } from '../context.js'
import { HttpError, type LambdaEvent, type LambdaResponse, badRequest, json, notFound, parseJsonBody } from '../http.js'
import { PROFILE_SK, userPk } from '../keys.js'
import { assertNetwork } from '../networks.js'
import { AUTH_LIMIT, enforce } from '../ratelimit.js'
import { AlreadyExists } from '../store.js'
import { assertEnabled, getSettings, touchLogin } from '../system.js'
import { requireSealed } from '../validate.js'
import { recordActivity } from './activity.js'
import { type Profile, issueSession, profileWithPassword } from './auth.js'
import { ssoGate, useTicket } from './sso.js'
import type { WebauthnCredential } from './webauthn.js'

export interface UnlockPasskey extends WebauthnCredential {
  /** The vault key, wrapped by the browser under this passkey's PRF output. */
  wrappedVaultKey: string
  /** The account's email, sealed the same way: the server keeps only a digest. */
  sealedEmail: string
}

type WithPasskeys = Profile & {
  webauthn?: WebauthnCredential[]
  passkeys?: UnlockPasskey[]
  pendingPasskey?: { challenge: string; expiresAt: number }
}

export const MAX_PASSKEYS = 10
const CHALLENGE_MS = 5 * 60_000
const LOGIN_PK = 'PASSKEY_LOGIN'

const rp = (app: App) => ({ origin: app.config.origin, id: new URL(app.config.origin).hostname })
const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')
const refused = () => new HttpError(401, 'invalid_credentials', 'That passkey does not unlock a vault on this server.')

// ── Enrolling, while unlocked ─────────────────────────────────────────────

/** Step one: proof of the master password, then options for a discoverable
 *  credential that must verify its user. The browser adds the PRF request. */
export async function enrolOptions(app: App, userId: string, event: LambdaEvent): Promise<LambdaResponse> {
  const profile = (await profileWithPassword(app, userId, parseJsonBody<Record<string, unknown>>(event))) as WithPasskeys
  const mine = profile.passkeys ?? []
  if (mine.length >= MAX_PASSKEYS) throw new HttpError(409, 'conflict', `At most ${MAX_PASSKEYS} passkeys. Remove one first.`)
  const { profile: inst } = await getSettings(app)
  const options = await generateRegistrationOptions({
    rpName: inst.name || 'Vault', rpID: rp(app).id,
    // The browser shows the account's email here; the server does not know it.
    userName: 'Vault account', userDisplayName: inst.name || 'Vault',
    userID: new TextEncoder().encode(userId),
    attestationType: 'none',
    excludeCredentials: [...mine, ...(profile.webauthn ?? [])].map((k) => ({ id: k.id, ...(k.transports ? { transports: k.transports } : {}) })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  })
  await app.store.put({ ...profile, pendingPasskey: { challenge: options.challenge, expiresAt: app.now() + CHALLENGE_MS } })
  return json(200, { options })
}

/** Step two: the browser's answer, verified, saved with the wrapping the
 *  browser made from the passkey's PRF output (and checked by opening it). */
export async function enrol(app: App, userId: string, event: LambdaEvent): Promise<LambdaResponse> {
  const b = parseJsonBody<Record<string, unknown>>(event)
  const wrappedVaultKey = requireSealed(b['wrappedVaultKey'], 'wrappedVaultKey', 4096)
  const sealedEmail = requireSealed(b['sealedEmail'], 'sealedEmail', 4096)
  const profile = (await app.store.get(userPk(userId), PROFILE_SK)) as WithPasskeys | null
  if (!profile) throw notFound()
  const pending = profile.pendingPasskey
  if (!pending || pending.expiresAt < app.now()) throw badRequest('That took too long. Start adding the passkey again.')
  const name = typeof b['name'] === 'string' && b['name'].trim() ? b['name'].trim().slice(0, 40) : 'Passkey'
  let result
  try {
    result = await verifyRegistrationResponse({
      response: b['response'] as RegistrationResponseJSON, expectedChallenge: pending.challenge,
      expectedOrigin: rp(app).origin, expectedRPID: rp(app).id, requireUserVerification: true,
    })
  } catch (err) {
    throw badRequest(`The passkey's answer could not be verified: ${(err as Error).message}`)
  }
  if (!result.verified || !result.registrationInfo) throw badRequest('The passkey could not be verified.')
  const c = result.registrationInfo.credential
  const mine = profile.passkeys ?? []
  if ([...mine, ...(profile.webauthn ?? [])].some((k) => k.id === c.id)) throw new HttpError(409, 'conflict', 'That passkey is already added.')
  if (mine.length >= MAX_PASSKEYS) throw new HttpError(409, 'conflict', `At most ${MAX_PASSKEYS} passkeys. Remove one first.`)
  const { pendingPasskey: _p, ...rest } = profile
  const key: UnlockPasskey = {
    id: c.id, publicKey: b64u(c.publicKey), counter: c.counter, ...(c.transports ? { transports: c.transports as AuthenticatorTransport[] } : {}),
    name, createdAt: new Date(app.now()).toISOString(), wrappedVaultKey, sealedEmail,
  }
  await app.store.put({ ...rest, passkeys: [...mine, key] })
  await recordActivity(app, userId, 'add-passkey', event)
  return json(201, { id: c.id, name })
}

/** Removing a way in weakens nothing, so the session alone is enough. */
export async function remove(app: App, userId: string, event: LambdaEvent, id: string): Promise<LambdaResponse> {
  const profile = (await app.store.get(userPk(userId), PROFILE_SK)) as WithPasskeys | null
  if (!profile || !(profile.passkeys ?? []).some((k) => k.id === id)) throw notFound()
  const keys = (profile.passkeys ?? []).filter((k) => k.id !== id)
  const { passkeys: _k, ...rest } = profile
  await app.store.put({ ...rest, ...(keys.length ? { passkeys: keys } : {}) } as Profile)
  await recordActivity(app, userId, 'remove-passkey', event)
  return json(200, { ok: true })
}

// ── Signing in ────────────────────────────────────────────────────────────

/** Options for navigator.credentials.get(): no account named, user
 *  verification required. The challenge is remembered for five minutes. */
export async function loginOptions(app: App, event: LambdaEvent): Promise<LambdaResponse> {
  await enforce(app.store, 'auth-ip', event.requestContext.http.sourceIp, AUTH_LIMIT, app.now())
  const options = await generateAuthenticationOptions({ rpID: rp(app).id, userVerification: 'required', allowCredentials: [] })
  await app.store.put({ pk: LOGIN_PK, sk: `C#${options.challenge}`, expiresAt: Math.floor((app.now() + CHALLENGE_MS) / 1000) })
  return json(200, { options })
}

function challengeOf(response: AuthenticationResponseJSON): string {
  try {
    const data = JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8')) as { challenge?: unknown }
    return typeof data.challenge === 'string' ? data.challenge : ''
  } catch { return '' }
}

/** The passkey's answer: checked, its challenge used up, and the vault key
 *  returned as the browser wrapped it. */
export async function login(app: App, event: LambdaEvent): Promise<LambdaResponse> {
  await enforce(app.store, 'auth-ip', event.requestContext.http.sourceIp, AUTH_LIMIT, app.now())
  const b = parseJsonBody<{ response?: unknown }>(event)
  const response = b.response as AuthenticationResponseJSON
  if (!response || typeof response !== 'object' || typeof response.id !== 'string' || !response.response || typeof response.response.clientDataJSON !== 'string') throw badRequest('response is required.')

  // The challenge must be one this server issued, unexpired, and unused.
  const challenge = challengeOf(response)
  if (!challenge || challenge.length > 200) throw refused()
  const issued = await app.store.get(LOGIN_PK, `C#${challenge}`)
  if (!issued || Number(issued['expiresAt']) * 1000 < app.now()) throw new HttpError(401, 'invalid_credentials', 'That took too long. Try the passkey again.')
  try {
    await app.store.put({ pk: LOGIN_PK, sk: `U#${challenge}`, expiresAt: Number(issued['expiresAt']) }, { mustNotExist: true })
  } catch (err) {
    if (err instanceof AlreadyExists) throw refused()
    throw err
  }
  await app.store.delete(LOGIN_PK, `C#${challenge}`)

  // The account is the one the passkey was made for (its user handle).
  const handle = typeof response.response.userHandle === 'string' ? Buffer.from(response.response.userHandle, 'base64url').toString('utf8') : ''
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(handle)) throw refused()
  const profile = (await app.store.get(userPk(handle), PROFILE_SK)) as WithPasskeys | null
  const key = profile?.passkeys?.find((k) => k.id === response.id)
  if (!profile || !key) throw refused()
  await enforce(app.store, 'auth-email', profile.emailDigest, AUTH_LIMIT, app.now())

  let info
  try {
    const r = await verifyAuthenticationResponse({
      response, expectedChallenge: challenge, expectedOrigin: rp(app).origin, expectedRPID: rp(app).id,
      credential: { id: key.id, publicKey: Buffer.from(key.publicKey, 'base64url'), counter: key.counter, ...(key.transports ? { transports: key.transports } : {}) },
      requireUserVerification: true,
    })
    if (!r.verified) throw refused()
    info = r.authenticationInfo
  } catch (err) {
    if (err instanceof HttpError) throw err
    throw refused()
  }
  await assertNetwork(app, profile.userId, event.requestContext.http.sourceIp)
  await assertEnabled(app, profile.userId)
  // A server that requires single sign-on requires it here too (decisions/0021).
  const sso = await ssoGate(app, profile, (b as { ssoTicket?: unknown }).ssoTicket)
  if (sso && !(await useTicket(app, sso))) throw new HttpError(401, 'sso_invalid', 'That single sign-on was already used. Sign in again.')

  const fresh = ((await app.store.get(userPk(profile.userId), PROFILE_SK)) as WithPasskeys | null) ?? profile
  await app.store.put({
    ...fresh,
    passkeys: (fresh.passkeys ?? []).map((k) => (k.id === key.id ? { ...k, counter: info.newCounter, lastUsedAt: new Date(app.now()).toISOString() } : k)),
  })
  await touchLogin(app, profile.userId, profile)
  await recordActivity(app, profile.userId, 'passkey-login', event)
  return json(200, {
    credentialId: key.id,
    wrappedVaultKey: key.wrappedVaultKey,
    sealedEmail: key.sealedEmail,
    kdf: profile.kdf,
    ...(await issueSession(app, profile.userId, event)),
  })
}
