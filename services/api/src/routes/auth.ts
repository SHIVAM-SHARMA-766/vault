// Registration, login, recovery, and session lifecycle.
//
// The server never sees the master password. It receives an Auth Key — a
// separate, non-invertible HKDF branch of the key that encrypts the vault —
// and stores only an scrypt verifier of it. See
// vault/decisions/0001-cryptography-and-key-hierarchy.md.

import { randomUUID } from 'node:crypto'

import type { App } from '../context.js'
import {
  HttpError,
  type LambdaEvent,
  type LambdaResponse,
  badRequest,
  conflict,
  forbidden,
  invalidCredentials,
  json,
  parseJsonBody,
  unauthorized,
} from '../http.js'
import { describeDevice } from '../device.js'
import { notify, signInNotice } from '../mail.js'
import { decoyHasSecretKey, decoySalt, emailDigest } from '../identity.js'
import {
  EMAIL_SK,
  PROFILE_SK,
  SESSION_PREFIX,
  SYSTEM_PK,
  emailPk,
  inviteSk,
  sessionSk,
  userPk,
} from '../keys.js'
import { AUTH_LIMIT, enforce } from '../ratelimit.js'
import { AlreadyExists, type Item } from '../store.js'
import {
  ACCESS_TTL_SECONDS,
  issueAccessToken,
  issueRefreshToken,
  verifyToken,
} from '../tokens.js'
import { hashAuthKey, verifyAuthKey } from '../verifier.js'
import { type KdfParams, requireBase64UrlBytes, requireEmail, requireIdentity, requireKdf, requireSealed } from '../validate.js'
import { recordActivity } from './activity.js'
import {
  type TotpState,
  hashRecoveryCode,
  invalidTwoFactor,
  newRecoveryCodes,
  newSecret,
  openSecret,
  sealSecret,
  twoFactorRequired,
  verifyTotp,
  hasSecondFactor,
} from '../twofactor.js'
import { isStaff, permissionsOf, roleFromDigest } from '../roles.js'
import {
  assertEnabled,
  claimInvite,
  getRegistry,
  getSettings,
  serverPolicyGap,
  hashInviteCode,
  listRegistry,
  putRegistry,
  touchLogin,
} from '../system.js'
import { assertNetwork } from '../networks.js'
import { loginOptions, verifyLogin } from './webauthn.js'

export interface Profile extends Item {
  userId: string
  emailDigest: string
  kdf: KdfParams
  authVerifier: string
  recoveryVerifier: string
  wrappedVaultKey: string
  wrappedVaultKeyForRecovery: string
  /** The account's identity key pair (decisions/0009). Absent on accounts
   *  created before identity keys existed until their next unlock enrols one. */
  publicKey?: string
  wrappedPrivateKey?: string
  /** Two-factor sign-in (decisions/0011). */
  totp?: TotpState
  pendingTotp?: { secret: string; expiresAt: number }
  recoveryCodes?: string[]
  createdAt: string
  updatedAt: string
}

async function limitAuth(app: App, event: LambdaEvent, email: string): Promise<void> {
  const digest = emailDigest(email, app.config.pepper)
  // Both, so that one attacker cannot spread guesses across addresses and one
  // address cannot be attacked from many hosts.
  await enforce(app.store, 'auth-ip', event.requestContext.http.sourceIp, AUTH_LIMIT, app.now())
  await enforce(app.store, 'auth-email', digest, AUTH_LIMIT, app.now())
}

/** A signed-in device. Refreshing rotates the record (a new token id each
 *  time) but carries the device's `sid`, name and first sign-in forward, so
 *  the owner sees one stable row per device. */
export interface SessionRecord extends Item {
  sid?: string
  createdAt: string
  lastUsedAt?: string
  device?: string
  ip?: string
  name?: string
}

/** When a device signed in at `createdAt` must sign in again under the
 *  server's session policy (epoch seconds), or undefined when it sets none. */
async function sessionDeadline(app: App, createdAt: string): Promise<number | undefined> {
  const days = (await getSettings(app)).policy.sessionDays
  return days ? Math.floor(Date.parse(createdAt) / 1000) + days * 86_400 : undefined
}

async function issueSession(app: App, userId: string, event: LambdaEvent, family?: SessionRecord) {
  const now = new Date(app.now()).toISOString()
  const refresh = issueRefreshToken(userId, app.config.tokenKey, app.now(), await sessionDeadline(app, family?.createdAt ?? now))
  // Sessions from before devices had ids keep their old token id as one.
  const sid = family ? (family.sid ?? family.sk.slice(SESSION_PREFIX.length)) : randomUUID()
  const access = issueAccessToken(userId, app.config.tokenKey, app.now(), sid)
  const record: SessionRecord = {
    pk: userPk(userId),
    sk: sessionSk(refresh.tokenId),
    sid,
    expiresAt: refresh.expiresAt,
    createdAt: family?.createdAt ?? now,
    lastUsedAt: now,
    device: describeDevice(event.requestContext.http.userAgent),
    ip: event.requestContext.http.sourceIp,
    ...(family?.name ? { name: family.name } : {}),
  }
  await app.store.put(record)
  return {
    accessToken: access,
    refreshToken: refresh.token,
    expiresIn: ACCESS_TTL_SECONDS,
  }
}

/** Fire and forget: the address is in this request and nowhere else. */
function sendSignInNotice(app: App, email: string, event: LambdaEvent, recovery: boolean): void {
  if (!app.mailer) return
  const at = new Date(app.now()).toUTCString()
  void notify(app, { to: email, ...signInNotice(app.config.origin, describeDevice(event.requestContext.http.userAgent), event.requestContext.http.sourceIp, at, recovery) })
}

export async function revokeAllSessions(app: App, userId: string): Promise<void> {
  const sessions = await app.store.query(userPk(userId), SESSION_PREFIX)
  for (const s of sessions) await app.store.delete(s.pk, s.sk)
}

/** The salt a client needs before it can derive anything.
 *
 *  An unknown address receives a deterministic decoy rather than an error, so
 *  the endpoint cannot be used to discover which addresses are registered.
 *  See docs/threat-model.md, A7. */
export async function prelogin(app: App, event: LambdaEvent): Promise<LambdaResponse> {
  const body = parseJsonBody<{ email?: unknown }>(event)
  const email = requireEmail(body.email)
  await limitAuth(app, event, email)

  const pointer = await app.store.get(emailPk(emailDigest(email, app.config.pepper)), EMAIL_SK)
  if (pointer) {
    return json(200, { kdf: pointer['kdf'] })
  }
  return json(200, {
    kdf: {
      algorithm: 'PBKDF2-HMAC-SHA256',
      iterations: 600_000,
      salt: decoySalt(email, app.config.pepper),
      ...(decoyHasSecretKey(email, app.config.pepper) ? { version: 2 } : {}),
    },
  })
}

const registrationRefused = () => new HttpError(403, 'forbidden', 'An account could not be created with these details. Check the invitation code — or, if you already have an account, sign in.')

export async function register(app: App, event: LambdaEvent): Promise<LambdaResponse> {
  // Closed by default. A missing or malformed setting therefore refuses rather
  // than silently leaving the vault open to anyone who finds the URL. The
  // environment override exists only to bootstrap the first account.
  const { registration: mode } = await getSettings(app)
  const body = parseJsonBody<Record<string, unknown>>(event)
  const inviteCode = typeof body['inviteCode'] === 'string' ? body['inviteCode'].trim() : ''
  // Checked before anything is written; claimed after, atomically.
  const pending = inviteCode && inviteCode.length <= 64
    ? await app.store.get(SYSTEM_PK, inviteSk(hashInviteCode(inviteCode)))
    : null
  const usable = !!pending && !pending['usedAt'] && Date.parse(String(pending['expiresAt'])) > app.now()
  // A first-run setup code works whatever the registration mode: on a new
  // server, it is how the owner gets in.
  const setup = usable && pending!['setup'] === true
  // A setup code only ever creates the first account.
  if (setup && (await listRegistry(app)).length > 0) throw forbidden()
  // A personal Vault has one account (decisions/0030): once it exists, nobody
  // else joins, whatever the registration setting says.
  if (app.config.edition === 'personal' && (await listRegistry(app)).length > 0) {
    throw new HttpError(403, 'forbidden', 'This is a personal Vault: it has one account, and no one else can join.')
  }
  const open = !setup && (app.allowRegistration || mode === 'open')
  if (!open && !setup && mode !== 'invite') throw registrationRefused()
  if (!open && !usable) throw registrationRefused()

  const email = requireEmail(body['email'])
  await limitAuth(app, event, email)

  const kdf = requireKdf(body['kdf'])
  const authKey = requireBase64UrlBytes(body['authKey'], 32, 'authKey')
  const recoveryAuthKey = requireBase64UrlBytes(body['recoveryAuthKey'], 32, 'recoveryAuthKey')
  const wrappedVaultKey = requireSealed(body['wrappedVaultKey'], 'wrappedVaultKey', 4096)
  const wrappedForRecovery = requireSealed(
    body['wrappedVaultKeyForRecovery'], 'wrappedVaultKeyForRecovery', 4096,
  )
  const identity = body['identity'] === undefined ? undefined : await requireIdentity(body['identity'])

  const digest = emailDigest(email, app.config.pepper)
  const userId = randomUUID()
  const at = new Date(app.now()).toISOString()

  // The pointer is written first, with a condition. Two concurrent
  // registrations for one address therefore lose in the database rather than
  // both creating a profile.
  try {
    await app.store.put(
      { pk: emailPk(digest), sk: EMAIL_SK, userId, kdf },
      { mustNotExist: true },
    )
  } catch (err) {
    // The same refusal as a bad invitation, so registration does not tell a
    // stranger whether an address has an account (threat A7).
    if (err instanceof AlreadyExists) throw registrationRefused()
    throw err
  }

  let inviteId: string | undefined
  let label: string | undefined
  let role: string | undefined
  if (!open) {
    const invite = await claimInvite(app, inviteCode, userId)
    if (!invite) {
      // Lost a race for the same code. Give the address back.
      await app.store.delete(emailPk(digest), EMAIL_SK)
      throw forbidden()
    }
    inviteId = invite.id
    label = invite.label
    role = invite.role
  }

  const [authVerifier, recoveryVerifier] = await Promise.all([
    hashAuthKey(authKey),
    hashAuthKey(recoveryAuthKey),
  ])

  const profile: Profile = {
    pk: userPk(userId), sk: PROFILE_SK,
    userId, emailDigest: digest, kdf,
    authVerifier, recoveryVerifier,
    wrappedVaultKey, wrappedVaultKeyForRecovery: wrappedForRecovery,
    ...(identity ? { publicKey: identity.publicKey, wrappedPrivateKey: identity.wrappedPrivateKey } : {}),
    createdAt: at, updatedAt: at,
  }
  await app.store.put(profile)
  await putRegistry(app, {
    userId,
    emailDigest: digest,
    createdAt: at,
    ...(label ? { label } : {}),
    ...(inviteId ? { inviteId } : {}),
    ...(role ? { role } : {}),
  })

  await recordActivity(app, userId, 'register', event)
  return json(201, { userId, ...(await issueSession(app, userId, event)) })
}

export async function login(app: App, event: LambdaEvent): Promise<LambdaResponse> {
  const body = parseJsonBody<Record<string, unknown>>(event)
  const email = requireEmail(body['email'])
  await limitAuth(app, event, email)
  const authKey = requireBase64UrlBytes(body['authKey'], 32, 'authKey')

  const profile = await profileByEmail(app, email)
  // An unknown address and a wrong auth key must be indistinguishable. The
  // verifier still runs against a dummy so that the response time does not
  // separate the two.
  const verifier = profile?.authVerifier ?? DUMMY_VERIFIER
  const ok = await verifyAuthKey(authKey, verifier)
  if (!ok || !profile) throw invalidCredentials()
  await assertNetwork(app, profile.userId, event.requestContext.http.sourceIp)
  // Only after the password is proved, so a disabled account cannot be told
  // apart from a wrong password by someone who does not hold it.
  await assertEnabled(app, profile.userId)
  await requireSecondFactor(app, profile, body, event)

  await touchLogin(app, profile.userId, profile)
  // The person can turn the ordinary sign-in email off (F5). Signing in with
  // the recovery key always sends one.
  if (app.config.mail.signInNotices && profile['signInAlerts'] !== false) sendSignInNotice(app, email, event, false)
  await recordActivity(app, profile.userId, 'login', event)
  return json(200, {
    wrappedVaultKey: profile.wrappedVaultKey,
    kdf: profile.kdf,
    ...(await issueSession(app, profile.userId, event)),
  })
}

/** Login with the recovery key, for when the master password is gone.
 *
 *  Returns the recovery-wrapped vault key, which the client unwraps locally.
 *  The recovery key proves itself through its own HKDF branch — the server
 *  never sees the branch that actually unwraps the vault. */
export async function recoveryLogin(app: App, event: LambdaEvent): Promise<LambdaResponse> {
  const body = parseJsonBody<Record<string, unknown>>(event)
  const email = requireEmail(body['email'])
  await limitAuth(app, event, email)
  const proof = requireBase64UrlBytes(body['recoveryAuthKey'], 32, 'recoveryAuthKey')

  const profile = await profileByEmail(app, email)
  const verifier = profile?.recoveryVerifier ?? DUMMY_VERIFIER
  const ok = await verifyAuthKey(proof, verifier)
  if (!ok || !profile) throw invalidCredentials()
  await assertNetwork(app, profile.userId, event.requestContext.http.sourceIp)
  await assertEnabled(app, profile.userId)
  // The recovery key replaces the password, not the second factor; losing
  // the phone too is what recovery codes are for.
  await requireSecondFactor(app, profile, body, event)

  // A recovery key in use means the master password is believed lost. Every
  // existing session is dropped, because the next step is to set a new one.
  await revokeAllSessions(app, profile.userId)
  await recordActivity(app, profile.userId, 'recovery-login', event)
  sendSignInNotice(app, email, event, true)

  return json(200, {
    wrappedVaultKeyForRecovery: profile.wrappedVaultKeyForRecovery,
    ...(await issueSession(app, profile.userId, event)),
  })
}

export async function refresh(app: App, event: LambdaEvent): Promise<LambdaResponse> {
  const body = parseJsonBody<{ refreshToken?: unknown }>(event)
  if (typeof body.refreshToken !== 'string') throw badRequest('refreshToken is required.')

  const payload = verifyToken(body.refreshToken, 'refresh', app.config.tokenKey, app.now())
  if (!payload?.jti) throw unauthorized()

  const session = await app.store.get(userPk(payload.sub), sessionSk(payload.jti))
  if (!session) {
    // The token verified but its session is gone: either it was already
    // rotated away, or it was revoked. A replayed refresh token is the
    // signature of a stolen one, so every session is dropped rather than just
    // this one.
    await revokeAllSessions(app, payload.sub)
    throw unauthorized()
  }

  await app.store.delete(userPk(payload.sub), sessionSk(payload.jti))
  await assertEnabled(app, payload.sub)
  await assertNetwork(app, payload.sub, event.requestContext.http.sourceIp)
  // A session policy set or shortened after this device signed in applies
  // now: past its deadline, the device signs in again.
  const deadline = await sessionDeadline(app, String(session['createdAt']))
  if (deadline !== undefined && deadline <= Math.floor(app.now() / 1000)) throw unauthorized()
  return json(200, await issueSession(app, payload.sub, event, session as SessionRecord))
}

/** Ends the session a refresh token belongs to. Needs no access token: holding
 *  the refresh token is the right to end it, and a client locking after a long
 *  idle no longer has a live access token. Always 200, so it reveals nothing
 *  about whether the session still existed. */
export async function signOut(app: App, event: LambdaEvent): Promise<LambdaResponse> {
  const body = parseJsonBody<{ refreshToken?: unknown }>(event)
  if (typeof body.refreshToken !== 'string') throw badRequest('refreshToken is required.')
  const payload = verifyToken(body.refreshToken, 'refresh', app.config.tokenKey, app.now())
  if (payload?.jti) await app.store.delete(userPk(payload.sub), sessionSk(payload.jti))
  return json(200, { ok: true })
}

export async function logout(app: App, userId: string, event: LambdaEvent): Promise<LambdaResponse> {
  const body = parseJsonBody<{ refreshToken?: unknown; all?: unknown }>(event)
  if (body.all === true) {
    await revokeAllSessions(app, userId)
    return json(200, { ok: true })
  }
  if (typeof body.refreshToken === 'string') {
    const payload = verifyToken(body.refreshToken, 'refresh', app.config.tokenKey, app.now())
    if (payload?.jti && payload.sub === userId) {
      await app.store.delete(userPk(userId), sessionSk(payload.jti))
    }
  }
  return json(200, { ok: true })
}

/** The strength score (0–4, packages/core passwordStrength) of the master
 *  password, as this account's own app computed it at unlock or change.
 *  Self-reported — the server never sees the password — and used only for
 *  organization policies, which say so. */
export async function setPasswordScore(app: App, userId: string, event: LambdaEvent): Promise<LambdaResponse> {
  const score = parseJsonBody<{ score?: unknown }>(event).score
  if (typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > 4) throw badRequest('score must be 0 to 4.')
  const profile = await app.store.get(userPk(userId), PROFILE_SK)
  if (!profile) throw unauthorized()
  if (profile['passwordScore'] !== score) await app.store.put({ ...profile, passwordScore: score })
  return json(200, { ok: true })
}

export async function me(app: App, userId: string): Promise<LambdaResponse> {
  const profile = (await app.store.get(userPk(userId), PROFILE_SK)) as Profile | null
  if (!profile) throw unauthorized()
  const role = roleFromDigest(app, profile.emailDigest, (await getRegistry(app, userId))?.role)
  const { policy } = await getSettings(app)
  return json(200, {
    userId: profile.userId,
    kdf: profile.kdf,
    wrappedVaultKey: profile.wrappedVaultKey,
    createdAt: profile.createdAt,
    role,
    isAdmin: isStaff(role),
    permissions: permissionsOf(role),
    twoFactor: {
      enabled: hasSecondFactor(profile as unknown as Record<string, unknown>), totp: Boolean(profile.totp), recoveryCodesLeft: profile.recoveryCodes?.length ?? 0,
      keys: ((profile as { webauthn?: { id: string; name: string; createdAt: string; lastUsedAt?: string }[] }).webauthn ?? []).map((k) => ({ id: k.id, name: k.name, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt ?? null })),
    },
    // What the server asks of this account, and what it still misses.
    policy: { requireTwoFactor: policy.requireTwoFactor, minPasswordScore: policy.minPasswordScore, maxIdleMinutes: policy.maxIdleMinutes, shareLinks: policy.shareLinks, shareLinkMaxDays: policy.shareLinkMaxDays },
    policyGap: serverPolicyGap(policy, profile),
    identity: profile.publicKey && profile.wrappedPrivateKey
      ? {
          publicKey: profile.publicKey, wrappedPrivateKey: profile.wrappedPrivateKey,
          ...((profile as { signingPublicKey?: string }).signingPublicKey ? { signingPublicKey: (profile as { signingPublicKey?: string }).signingPublicKey, wrappedSigningKey: (profile as { wrappedSigningKey?: string }).wrappedSigningKey } : {}),
        }
      : null,
  })
}

/** Enrols an identity key pair on an account that has none. Once set it is
 *  not replaced here: a silent swap of someone's public key is exactly the
 *  attack sharing has to resist, so rotation, when it exists, will be its own
 *  deliberate flow that re-shares and is audited. */
export async function setIdentity(app: App, userId: string, event: LambdaEvent): Promise<LambdaResponse> {
  const body = parseJsonBody<Record<string, unknown>>(event)
  const identity = await requireIdentity(body)
  const profile = (await app.store.get(userPk(userId), PROFILE_SK)) as Profile | null
  if (!profile) throw unauthorized()
  if (profile.publicKey) throw conflict('This account already has an identity key.')
  await app.store.put({
    ...profile,
    publicKey: identity.publicKey,
    wrappedPrivateKey: identity.wrappedPrivateKey,
    updatedAt: new Date(app.now()).toISOString(),
  })
  await recordActivity(app, userId, 'enrol-identity', event)
  return json(200, { ok: true })
}

/** Change the master password.
 *
 *  A single write. The vault key does not change, so no entry is re-encrypted
 *  and history survives — the whole reason the key hierarchy has a vault key
 *  in the middle. */
export async function changePassword(
  app: App, userId: string, event: LambdaEvent,
): Promise<LambdaResponse> {
  const body = parseJsonBody<Record<string, unknown>>(event)
  // Proof of the current password, or — after signing in with the recovery
  // key, when the password is exactly what has been lost — proof of the
  // recovery key. One of the two is required.
  const byRecovery = body['currentAuthKey'] === undefined && body['recoveryAuthKey'] !== undefined
  const proof = byRecovery
    ? requireBase64UrlBytes(body['recoveryAuthKey'], 32, 'recoveryAuthKey')
    : requireBase64UrlBytes(body['currentAuthKey'], 32, 'currentAuthKey')
  const newAuthKey = requireBase64UrlBytes(body['newAuthKey'], 32, 'newAuthKey')
  const kdf = requireKdf(body['kdf'])
  const wrappedVaultKey = requireSealed(body['wrappedVaultKey'], 'wrappedVaultKey', 4096)

  const profile = (await app.store.get(userPk(userId), PROFILE_SK)) as Profile | null
  if (!profile) throw unauthorized()

  // Holding a valid access token is not enough; the current password (or the
  // recovery key) has to be proved again, so a stolen token cannot lock the
  // owner out.
  const verifier = byRecovery ? profile.recoveryVerifier : profile.authVerifier
  if (!(await verifyAuthKey(proof, verifier))) throw invalidCredentials()

  const updated: Profile = {
    ...profile,
    kdf,
    authVerifier: await hashAuthKey(newAuthKey),
    wrappedVaultKey,
    updatedAt: new Date(app.now()).toISOString(),
  }
  await app.store.put(updated)
  await app.store.put({ pk: emailPk(profile.emailDigest), sk: EMAIL_SK, userId, kdf })

  // Every other session was authenticated with the old password.
  await revokeAllSessions(app, userId)
  // Adding or removing a secret key is a re-derivation too (decisions/0027).
  const before = profile.kdf?.version === 2, after = kdf.version === 2
  const what = byRecovery ? 'reset-password-with-recovery-key'
    : before === after ? 'change-password' : after ? 'add-secret-key' : 'remove-secret-key'
  await recordActivity(app, userId, what, event)

  return json(200, await issueSession(app, userId, event))
}

/** Issue a replacement recovery key, invalidating the previous one. */
export async function rotateRecovery(
  app: App, userId: string, event: LambdaEvent,
): Promise<LambdaResponse> {
  const body = parseJsonBody<Record<string, unknown>>(event)
  const currentAuthKey = requireBase64UrlBytes(body['currentAuthKey'], 32, 'currentAuthKey')
  const recoveryAuthKey = requireBase64UrlBytes(body['recoveryAuthKey'], 32, 'recoveryAuthKey')
  const wrapped = requireSealed(body['wrappedVaultKeyForRecovery'], 'wrappedVaultKeyForRecovery', 4096)

  const profile = (await app.store.get(userPk(userId), PROFILE_SK)) as Profile | null
  if (!profile) throw unauthorized()
  // Replacing the recovery key invalidates the old one. A stolen access token
  // must not be enough to take that way back away from the owner.
  if (!(await verifyAuthKey(currentAuthKey, profile.authVerifier))) throw invalidCredentials()

  await app.store.put({
    ...profile,
    recoveryVerifier: await hashAuthKey(recoveryAuthKey),
    wrappedVaultKeyForRecovery: wrapped,
    updatedAt: new Date(app.now()).toISOString(),
  })
  await recordActivity(app, userId, 'rotate-recovery-key', event)
  return json(200, { ok: true })
}

async function profileByEmail(app: App, email: string): Promise<Profile | null> {
  const pointer = await app.store.get(emailPk(emailDigest(email, app.config.pepper)), EMAIL_SK)
  if (!pointer || typeof pointer['userId'] !== 'string') return null
  return (await app.store.get(userPk(pointer['userId']), PROFILE_SK)) as Profile | null
}

/** A real verifier over a value nobody holds. Used so that a login for an
 *  unknown address does the same work as one for a known address, and the two
 *  cannot be told apart by how long the response takes. */
const DUMMY_VERIFIER =
  'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

// ── Two-factor sign-in ─────────────────────────────────────────────────────

/** Checks the second factor on an account that has one. Called after the
 *  password (or recovery key) is proved. Consumes a recovery code if one is
 *  used, and records the step of a TOTP code so it cannot be replayed. */
/** A marker row written with a condition: true for the first caller only. */
async function claimOnce(app: App, userId: string, sk: string, ttlSeconds: number): Promise<boolean> {
  try {
    await app.store.put({ pk: userPk(userId), sk, expiresAt: Math.floor(app.now() / 1000) + ttlSeconds }, { mustNotExist: true })
    return true
  } catch (err) {
    if (err instanceof AlreadyExists) return false
    throw err
  }
}

export async function requireSecondFactor(
  app: App, profile: Profile, body: Record<string, unknown>, event: LambdaEvent,
): Promise<void> {
  if (!hasSecondFactor(profile as unknown as Record<string, unknown>)) return
  const code = typeof body['totpCode'] === 'string' ? body['totpCode'].replace(/\s/g, '') : ''
  const recovery = typeof body['recoveryCode'] === 'string' ? body['recoveryCode'] : ''
  // A passkey or security key (decisions/0022).
  if (body['webauthn'] !== undefined && !code && !recovery) {
    if (await verifyLogin(app, profile, body['webauthn'])) return
    throw new HttpError(401, 'invalid_two_factor', 'That key did not verify. Try again, or use another key, your authenticator app or a recovery code.')
  }
  if (!code && !recovery) {
    const err = twoFactorRequired()
    err.details = { methods: [...(profile.totp ? ['totp'] : []), ...((profile as { webauthn?: unknown[] }).webauthn?.length ? ['webauthn'] : []), 'recovery'], webauthn: await loginOptions(app, profile) }
    throw err
  }
  if (code && !profile.totp) throw invalidTwoFactor()

  if (code) {
    const step = await verifyTotp(openSecret(profile.totp!.secret, app.config.pepper), code, app.now(), profile.totp!.lastStep)
    if (step === null) throw invalidTwoFactor()
    // Claimed atomically, so two sign-ins racing with one code cannot both
    // pass the read-then-write of lastStep.
    if (!(await claimOnce(app, profile.userId, `TOTPSTEP#${step}`, 10 * 60))) throw invalidTwoFactor()
    await app.store.put({ ...profile, totp: { ...profile.totp!, lastStep: step } })
    return
  }
  const hash = hashRecoveryCode(recovery, app.config.pepper)
  const left = (profile.recoveryCodes ?? []).filter((h) => h !== hash)
  if (left.length === (profile.recoveryCodes ?? []).length) throw invalidTwoFactor()
  if (!(await claimOnce(app, profile.userId, `RCUSED#${hash}`, 400 * 24 * 60 * 60))) throw invalidTwoFactor()
  await app.store.put({ ...profile, recoveryCodes: left })
  await recordActivity(app, profile.userId, 'used-2fa-recovery-code', event)
}

export async function profileWithPassword(app: App, userId: string, body: Record<string, unknown>): Promise<Profile> {
  const currentAuthKey = requireBase64UrlBytes(body['currentAuthKey'], 32, 'currentAuthKey')
  const profile = (await app.store.get(userPk(userId), PROFILE_SK)) as Profile | null
  if (!profile) throw unauthorized()
  if (!(await verifyAuthKey(currentAuthKey, profile.authVerifier))) throw invalidCredentials()
  return profile
}

/** Step one of turning it on: a new TOTP key, held as pending for ten
 *  minutes until a code from it proves the app has it. */
export async function setupTwoFactor(app: App, userId: string, event: LambdaEvent): Promise<LambdaResponse> {
  const profile = await profileWithPassword(app, userId, parseJsonBody<Record<string, unknown>>(event))
  if (profile.totp) throw conflict('Two-factor sign-in is already on. Turn it off first to use a different app.')
  const secret = newSecret()
  await app.store.put({
    ...profile,
    pendingTotp: { secret: sealSecret(secret, app.config.pepper), expiresAt: app.now() + 10 * 60_000 },
  })
  // The client builds the otpauth:// URI: it knows the address, the server does not.
  return json(200, { secret })
}

/** Step two: a valid code turns it on and issues recovery codes, once. */
export async function enableTwoFactor(app: App, userId: string, event: LambdaEvent): Promise<LambdaResponse> {
  const body = parseJsonBody<{ code?: unknown }>(event)
  const profile = (await app.store.get(userPk(userId), PROFILE_SK)) as Profile | null
  if (!profile) throw unauthorized()
  if (!profile.pendingTotp || profile.pendingTotp.expiresAt < app.now()) {
    throw badRequest('Start again: the setup has expired.')
  }
  const secret = openSecret(profile.pendingTotp.secret, app.config.pepper)
  const step = await verifyTotp(secret, typeof body.code === 'string' ? body.code.replace(/\s/g, '') : '', app.now())
  if (step === null) throw invalidTwoFactor()
  const codes = newRecoveryCodes()
  const { pendingTotp: _p, ...rest } = profile
  await app.store.put({
    ...rest,
    totp: { secret: profile.pendingTotp.secret, enabledAt: new Date(app.now()).toISOString(), lastStep: step },
    recoveryCodes: codes.map((c) => hashRecoveryCode(c, app.config.pepper)),
  } as Profile)
  await recordActivity(app, userId, 'enable-2fa', event)
  return json(200, { recoveryCodes: codes })
}

/** Turning it off needs the password and a current code (or a recovery code). */
export async function disableTwoFactor(app: App, userId: string, event: LambdaEvent): Promise<LambdaResponse> {
  const body = parseJsonBody<Record<string, unknown>>(event)
  const profile = await profileWithPassword(app, userId, body)
  if (!profile.totp) return json(200, { ok: true })
  await requireSecondFactor(app, profile, body, event)
  const fresh = (await app.store.get(userPk(userId), PROFILE_SK)) as Profile
  const { totp: _t, recoveryCodes, pendingTotp: _p, ...rest } = fresh
  // Recovery codes stay while a security key is still a second factor.
  const keysLeft = ((fresh as { webauthn?: unknown[] }).webauthn ?? []).length > 0
  await app.store.put({ ...rest, ...(keysLeft && recoveryCodes ? { recoveryCodes } : {}) } as Profile)
  await recordActivity(app, userId, 'disable-2fa', event)
  return json(200, { ok: true })
}

/** New recovery codes, replacing every old one. */
export async function regenerateRecoveryCodes(app: App, userId: string, event: LambdaEvent): Promise<LambdaResponse> {
  const body = parseJsonBody<Record<string, unknown>>(event)
  const profile = await profileWithPassword(app, userId, body)
  if (!hasSecondFactor(profile as unknown as Record<string, unknown>)) throw badRequest('Two-factor sign-in is not on.')
  await requireSecondFactor(app, profile, body, event)
  const fresh = (await app.store.get(userPk(userId), PROFILE_SK)) as Profile
  const codes = newRecoveryCodes()
  await app.store.put({ ...fresh, recoveryCodes: codes.map((c) => hashRecoveryCode(c, app.config.pepper)) })
  await recordActivity(app, userId, 'regenerate-2fa-recovery-codes', event)
  return json(200, { recoveryCodes: codes })
}

/** Enrols the account's signing key (decisions/0025), once. Like the identity
 *  key, it is never replaced silently: rotation would be its own flow. */
export async function setSigningKey(app: App, userId: string, event: LambdaEvent): Promise<LambdaResponse> {
  const b = parseJsonBody<Record<string, unknown>>(event)
  const pub = typeof b['signingPublicKey'] === 'string' && /^[A-Za-z0-9_-]{87}$/.test(b['signingPublicKey']) ? b['signingPublicKey'] : null
  if (!pub) throw badRequest('signingPublicKey must be a P-256 public key.')
  const wrapped = requireSealed(b['wrappedSigningKey'], 'wrappedSigningKey', 4096)
  const profile = (await app.store.get(userPk(userId), PROFILE_SK)) as (Profile & { signingPublicKey?: string }) | null
  if (!profile) throw unauthorized()
  if (profile.signingPublicKey) throw conflict('This account already has a signing key.')
  await app.store.put({ ...profile, signingPublicKey: pub, wrappedSigningKey: wrapped, updatedAt: new Date(app.now()).toISOString() })
  await recordActivity(app, userId, 'enrol-identity', event)
  return json(200, { ok: true })
}
