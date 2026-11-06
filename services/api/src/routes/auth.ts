// Registration, login, recovery, and session lifecycle.
//
// The server never sees the master password. It receives an Auth Key — a
// separate, non-invertible HKDF branch of the key that encrypts the vault —
// and stores only an scrypt verifier of it. See
// vault/decisions/0001-cryptography-and-key-hierarchy.md.

import { randomUUID } from 'node:crypto'

import type { App } from '../context.js'
import {
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
import { decoySalt, emailDigest } from '../identity.js'
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
import { isStaff, permissionsOf, roleFromDigest } from '../roles.js'
import {
  assertEnabled,
  claimInvite,
  getRegistry,
  getSettings,
  hashInviteCode,
  putRegistry,
  touchLogin,
} from '../system.js'

interface Profile extends Item {
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

async function issueSession(app: App, userId: string) {
  const access = issueAccessToken(userId, app.config.tokenKey, app.now())
  const refresh = issueRefreshToken(userId, app.config.tokenKey, app.now())
  await app.store.put({
    pk: userPk(userId),
    sk: sessionSk(refresh.tokenId),
    expiresAt: refresh.expiresAt,
    createdAt: new Date(app.now()).toISOString(),
  })
  return {
    accessToken: access,
    refreshToken: refresh.token,
    expiresIn: ACCESS_TTL_SECONDS,
  }
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
    },
  })
}

export async function register(app: App, event: LambdaEvent): Promise<LambdaResponse> {
  // Closed by default. A missing or malformed setting therefore refuses rather
  // than silently leaving the vault open to anyone who finds the URL. The
  // environment override exists only to bootstrap the first account.
  const { registration: mode } = await getSettings(app)
  const open = app.allowRegistration || mode === 'open'
  if (!open && mode !== 'invite') throw forbidden()

  const body = parseJsonBody<Record<string, unknown>>(event)
  const inviteCode = typeof body['inviteCode'] === 'string' ? body['inviteCode'].trim() : ''
  if (!open) {
    // Checked before anything is written; claimed after, atomically.
    if (!inviteCode || inviteCode.length > 64) throw forbidden()
    const pending = await app.store.get(SYSTEM_PK, inviteSk(hashInviteCode(inviteCode)))
    if (!pending || pending['usedAt'] || Date.parse(String(pending['expiresAt'])) <= app.now()) {
      throw forbidden()
    }
  }

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
    if (err instanceof AlreadyExists) throw conflict('That address is already registered.')
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
  return json(201, { userId, ...(await issueSession(app, userId)) })
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
  // Only after the password is proved, so a disabled account cannot be told
  // apart from a wrong password by someone who does not hold it.
  await assertEnabled(app, profile.userId)

  await touchLogin(app, profile.userId, profile)
  await recordActivity(app, profile.userId, 'login', event)
  return json(200, {
    wrappedVaultKey: profile.wrappedVaultKey,
    kdf: profile.kdf,
    ...(await issueSession(app, profile.userId)),
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
  await assertEnabled(app, profile.userId)

  // A recovery key in use means the master password is believed lost. Every
  // existing session is dropped, because the next step is to set a new one.
  await revokeAllSessions(app, profile.userId)
  await recordActivity(app, profile.userId, 'recovery-login', event)

  return json(200, {
    wrappedVaultKeyForRecovery: profile.wrappedVaultKeyForRecovery,
    ...(await issueSession(app, profile.userId)),
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
  return json(200, await issueSession(app, payload.sub))
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

export async function me(app: App, userId: string): Promise<LambdaResponse> {
  const profile = (await app.store.get(userPk(userId), PROFILE_SK)) as Profile | null
  if (!profile) throw unauthorized()
  const role = roleFromDigest(app, profile.emailDigest, (await getRegistry(app, userId))?.role)
  return json(200, {
    userId: profile.userId,
    kdf: profile.kdf,
    wrappedVaultKey: profile.wrappedVaultKey,
    createdAt: profile.createdAt,
    role,
    isAdmin: isStaff(role),
    permissions: permissionsOf(role),
    identity: profile.publicKey && profile.wrappedPrivateKey
      ? { publicKey: profile.publicKey, wrappedPrivateKey: profile.wrappedPrivateKey }
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
  await recordActivity(app, userId, byRecovery ? 'reset-password-with-recovery-key' : 'change-password', event)

  return json(200, await issueSession(app, userId))
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
