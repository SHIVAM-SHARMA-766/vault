// Passkeys and security keys as a second factor (D9, decisions/0022). WebAuthn
// proves possession of a key at sign-in, beside or instead of an authenticator
// app. It protects sign-in only: the master password still derives the key
// that opens the vault. Parsing and signature checks are @simplewebauthn's.

import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type AuthenticatorTransport, type RegistrationResponseJSON,
} from '@simplewebauthn/server'

import type { App } from '../context.js'
import { HttpError, type LambdaEvent, type LambdaResponse, badRequest, json, notFound, parseJsonBody } from '../http.js'
import { PROFILE_SK, userPk } from '../keys.js'
import { getSettings } from '../system.js'
import { hashRecoveryCode, hasSecondFactor, newRecoveryCodes } from '../twofactor.js'
import { recordActivity } from './activity.js'
import { type Profile, profileWithPassword, requireSecondFactor } from './auth.js'

export interface WebauthnCredential {
  id: string
  publicKey: string        // base64url COSE key
  counter: number
  transports?: AuthenticatorTransport[]
  name: string
  createdAt: string
  lastUsedAt?: string
}

type WithWebauthn = Profile & {
  webauthn?: WebauthnCredential[]
  pendingWebauthn?: { challenge: string; expiresAt: number }
  webauthnLogin?: { challenge: string; expiresAt: number }
}

export const MAX_KEYS = 10
const CHALLENGE_MS = 5 * 60_000

const rp = (app: App) => {
  const origin = app.config.origin
  return { origin, id: new URL(origin).hostname }
}
const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')

/** Step one of adding a key: proof of the master password, then options for
 *  the browser's navigator.credentials.create(). */
export async function registerOptions(app: App, userId: string, event: LambdaEvent): Promise<LambdaResponse> {
  const profile = (await profileWithPassword(app, userId, parseJsonBody<Record<string, unknown>>(event))) as WithWebauthn
  const keys = profile.webauthn ?? []
  if (keys.length >= MAX_KEYS) throw new HttpError(409, 'conflict', `At most ${MAX_KEYS} keys. Remove one first.`)
  const { profile: inst } = await getSettings(app)
  const options = await generateRegistrationOptions({
    rpName: inst.name || 'Vault', rpID: rp(app).id,
    userName: 'Vault account', userDisplayName: inst.name || 'Vault',
    userID: new TextEncoder().encode(userId),
    attestationType: 'none',
    excludeCredentials: keys.map((k) => ({ id: k.id, ...(k.transports ? { transports: k.transports } : {}) })),
    authenticatorSelection: { residentKey: 'discouraged', userVerification: 'preferred' },
  })
  await app.store.put({ ...profile, pendingWebauthn: { challenge: options.challenge, expiresAt: app.now() + CHALLENGE_MS } })
  return json(200, { options })
}

/** Step two: the browser's answer, verified, and the key saved. The first
 *  second factor on an account also brings recovery codes, shown once. */
export async function register(app: App, userId: string, event: LambdaEvent): Promise<LambdaResponse> {
  const b = parseJsonBody<{ response?: unknown; name?: unknown }>(event)
  const profile = (await app.store.get(userPk(userId), PROFILE_SK)) as WithWebauthn | null
  if (!profile) throw notFound()
  const pending = profile.pendingWebauthn
  if (!pending || pending.expiresAt < app.now()) throw badRequest('That took too long. Start adding the key again.')
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 40) : 'Security key'
  let result
  try {
    result = await verifyRegistrationResponse({
      response: b.response as RegistrationResponseJSON, expectedChallenge: pending.challenge,
      expectedOrigin: rp(app).origin, expectedRPID: rp(app).id, requireUserVerification: false,
    })
  } catch (err) {
    throw badRequest(`The key's answer could not be verified: ${(err as Error).message}`)
  }
  if (!result.verified || !result.registrationInfo) throw badRequest('The key could not be verified.')
  const c = result.registrationInfo.credential
  const keys = profile.webauthn ?? []
  if (keys.some((k) => k.id === c.id)) throw new HttpError(409, 'conflict', 'That key is already added.')
  const first = !hasSecondFactor(profile)
  const codes = first ? newRecoveryCodes() : null
  const { pendingWebauthn: _p, ...rest } = profile
  await app.store.put({
    ...rest,
    webauthn: [...keys, { id: c.id, publicKey: b64u(c.publicKey), counter: c.counter, ...(c.transports ? { transports: c.transports } : {}), name, createdAt: new Date(app.now()).toISOString() }],
    ...(codes ? { recoveryCodes: codes.map((x) => hashRecoveryCode(x, app.config.pepper)) } : {}),
  })
  await recordActivity(app, userId, 'add-security-key', event)
  return json(201, { id: c.id, name, ...(codes ? { recoveryCodes: codes } : {}) })
}

/** Removing a key needs the master password and a second factor, like
 *  turning off the authenticator app. */
export async function removeKey(app: App, userId: string, event: LambdaEvent, id: string): Promise<LambdaResponse> {
  const body = parseJsonBody<Record<string, unknown>>(event)
  const profile = (await profileWithPassword(app, userId, body)) as WithWebauthn
  if (!(profile.webauthn ?? []).some((k) => k.id === id)) throw notFound()
  await requireSecondFactor(app, profile, body, event)
  const fresh = (await app.store.get(userPk(userId), PROFILE_SK)) as WithWebauthn
  const keys = (fresh.webauthn ?? []).filter((k) => k.id !== id)
  const { webauthn: _w, recoveryCodes, ...rest } = fresh
  const still = keys.length > 0 || Boolean(fresh.totp)
  await app.store.put({ ...rest, ...(keys.length ? { webauthn: keys } : {}), ...(still && recoveryCodes ? { recoveryCodes } : {}) } as Profile)
  await recordActivity(app, userId, 'remove-security-key', event)
  return json(200, { ok: true })
}

/** At sign-in, when no factor was sent: options for navigator.credentials.get(),
 *  remembered for five minutes. Called only after the password is proved. */
export async function loginOptions(app: App, profile: WithWebauthn): Promise<unknown> {
  const keys = profile.webauthn ?? []
  if (!keys.length) return null
  const options = await generateAuthenticationOptions({
    rpID: rp(app).id, userVerification: 'preferred',
    allowCredentials: keys.map((k) => ({ id: k.id, ...(k.transports ? { transports: k.transports } : {}) })),
  })
  await app.store.put({ ...profile, webauthnLogin: { challenge: options.challenge, expiresAt: app.now() + CHALLENGE_MS } })
  return options
}

/** At sign-in: checks the key's answer against the remembered challenge,
 *  which is used up either way. True when it verifies. */
export async function verifyLogin(app: App, profile: WithWebauthn, response: unknown): Promise<boolean> {
  const fresh = (await app.store.get(userPk(profile.userId), PROFILE_SK)) as WithWebauthn
  const challenge = fresh.webauthnLogin
  const { webauthnLogin: _c, ...rest } = fresh
  await app.store.put(rest)
  if (!challenge || challenge.expiresAt < app.now()) return false
  const r = response as AuthenticationResponseJSON
  const key = (fresh.webauthn ?? []).find((k) => k.id === r?.id)
  if (!key) return false
  try {
    const { verified, authenticationInfo } = await verifyAuthenticationResponse({
      response: r, expectedChallenge: challenge.challenge, expectedOrigin: rp(app).origin, expectedRPID: rp(app).id,
      credential: { id: key.id, publicKey: Buffer.from(key.publicKey, 'base64url'), counter: key.counter, ...(key.transports ? { transports: key.transports } : {}) },
      requireUserVerification: false,
    })
    if (!verified) return false
    const keys = (fresh.webauthn ?? []).map((k) => (k.id === key.id ? { ...k, counter: authenticationInfo.newCounter, lastUsedAt: new Date(app.now()).toISOString() } : k))
    await app.store.put({ ...rest, webauthn: keys })
    return true
  } catch {
    return false
  }
}
