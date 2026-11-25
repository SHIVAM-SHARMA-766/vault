// The key hierarchy described in decisions/0001.
//
//   Master Password + per-user salt
//         | PBKDF2-SHA256, 600k
//         v
//    Master Key ---+--- HKDF "vault.kek.v1"      --> KEK, wraps the Vault Key
//                  +--- HKDF "vault.auth.v1"     --> Auth Key, sent to server
//
//    Vault Key (random, generated once, never rotates)
//         +-- wrapped by KEK           (master password path)
//         +-- wrapped by Recovery KEK  (recovery key path)
//
// The Auth Key and the KEK are separate HKDF branches of the same Master Key.
// The server necessarily sees the Auth Key on every login; because HKDF is not
// invertible and the two labels are domain-separated, that reveals nothing
// about the KEK and therefore nothing about the vault.
//
// The Vault Key indirection is what makes changing the master password a single
// write: the new password produces a new KEK, the Vault Key is rewrapped, and
// not one entry is touched.

import { fromRecoveryString, toBase64Url, toRecoveryString, utf8Encode } from './encoding.js'
import { type Argon2Params, argon2id } from './argon2.js'
import { hkdfSha256, pbkdf2Sha256 } from './primitives.js'
import { randomBytes } from './random.js'
import { seal, unseal } from './aead.js'
import { mixSecretKey } from './secretkey.js'

/** OWASP's 2023 floor for PBKDF2-HMAC-SHA256. Stored per user rather than
 *  assumed, so it can be raised for new accounts without breaking existing
 *  ones. */
export const PBKDF2_ITERATIONS = 600_000

export const SALT_BYTES = 32
export const KEY_BYTES = 32

/** HKDF domain separation. Changing any of these strings changes every key
 *  derived from it, which would make existing vaults undecryptable — they are
 *  versioned for that reason and must never be edited in place. */
const INFO_KEK = 'vault.kek.v1'
const INFO_AUTH = 'vault.auth.v1'
const INFO_RECOVERY = 'vault.recovery.v1'

/** The recovery key's authentication branch. Recovery happens when the master
 *  password is gone, so the usual auth key cannot be produced — but the server
 *  still must not hand the recovery-wrapped vault key to an unauthenticated
 *  caller. This branch lets the recovery key prove itself, exactly as the
 *  master password does through INFO_AUTH, without revealing the recovery KEK. */
const INFO_RECOVERY_AUTH = 'vault.recovery.auth.v1'

/** Bound into each wrapped Vault Key as additional authenticated data, so the
 *  recovery blob cannot be substituted for the master blob or the reverse. */
const AAD_WRAP_MASTER = 'vault.wrap.master.v1'
const AAD_WRAP_RECOVERY = 'vault.wrap.recovery.v1'

/** How a master password is stretched, as stored per account. PBKDF2 for
 *  accounts made before decisions/0028; Argon2id since. */
export type KdfParams = Pbkdf2Params | Argon2KdfParams

export interface Pbkdf2Params {
  algorithm: 'PBKDF2-HMAC-SHA256'
  iterations: number
  /** base64url. Generated per user; never derived from the email address, so
   *  that a password reused on another service cannot be attacked with
   *  precomputed tables. */
  salt: string
  /** 2 when a secret key is mixed in (decisions/0027); absent otherwise. */
  version?: 2
}

export interface Argon2KdfParams extends Argon2Params {
  algorithm: 'argon2id'
  salt: string
  version?: 2
}

/** OWASP's interactive-login setting (decisions/0028): 64 MiB, three passes,
 *  one lane. About half a second on a laptop, a second on a mid-range phone. */
export const ARGON2_DEFAULT: Argon2Params = { m: 65_536, t: 3, p: 1 }

/** What stretching costs: a PBKDF2 iteration count, or Argon2id parameters. */
export type KdfCost = number | Argon2Params

/** Limits on parameters read from a server or a file, so that neither can
 *  ask for a uselessly weak derivation or one that never finishes. */
export const KDF_LIMITS = {
  pbkdf2: { minIterations: 100_000, maxIterations: 10_000_000 },
  argon2: { minM: 19_456, maxM: 1_048_576, minT: 1, maxT: 10, minP: 1, maxP: 4, minMT: 38_912 },
} as const

/** Null when the parameters are within KDF_LIMITS; otherwise why not. */
export function kdfProblem(kdf: unknown): string | null {
  const k = kdf as { algorithm?: unknown; salt?: unknown; iterations?: number; m?: number; t?: number; p?: number } | null
  if (!k || typeof k !== 'object' || typeof k.salt !== 'string') return 'missing key derivation settings'
  if (k.algorithm === 'PBKDF2-HMAC-SHA256') {
    const { minIterations, maxIterations } = KDF_LIMITS.pbkdf2
    return Number.isInteger(k.iterations) && k.iterations! >= minIterations && k.iterations! <= maxIterations ? null : 'implausible PBKDF2 iteration count'
  }
  if (k.algorithm === 'argon2id') {
    const L = KDF_LIMITS.argon2
    const ok = [k.m, k.t, k.p].every(Number.isInteger) && k.m! >= L.minM && k.m! <= L.maxM && k.t! >= L.minT && k.t! <= L.maxT && k.p! >= L.minP && k.p! <= L.maxP && k.m! * k.t! >= L.minMT
    return ok ? null : 'implausible Argon2id parameters'
  }
  return 'unknown key derivation algorithm'
}

/** The cost stored in a KdfParams, for deriveMasterKey and friends. */
export function costOf(kdf: KdfParams): KdfCost {
  return kdf.algorithm === 'argon2id' ? { m: kdf.m, t: kdf.t, p: kdf.p } : kdf.iterations
}

/** Whether an account's derivation is older than the current default. */
export function kdfIsOutdated(kdf: KdfParams): boolean {
  return kdf.algorithm !== 'argon2id' || kdf.m < ARGON2_DEFAULT.m || kdf.t < ARGON2_DEFAULT.t
}

function kdfParams(salt: Uint8Array, cost: KdfCost, secretKey?: Uint8Array): KdfParams {
  const version = secretKey ? { version: 2 as const } : {}
  return typeof cost === 'number'
    ? { algorithm: 'PBKDF2-HMAC-SHA256', iterations: cost, salt: toBase64Url(salt), ...version }
    : { algorithm: 'argon2id', m: cost.m, t: cost.t, p: cost.p, salt: toBase64Url(salt), ...version }
}

/** Case and surrounding whitespace must not produce different accounts. Applied
 *  identically by the client before salt lookup and by the server before
 *  hashing the address for storage. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function generateSalt(): Uint8Array {
  return randomBytes(SALT_BYTES)
}

export function generateVaultKey(): Uint8Array {
  return randomBytes(KEY_BYTES)
}

export function generateRecoveryKey(): Uint8Array {
  return randomBytes(KEY_BYTES)
}

export { toRecoveryString as formatRecoveryKey, fromRecoveryString as parseRecoveryKey }

export async function deriveMasterKey(
  password: string,
  salt: Uint8Array,
  cost: KdfCost = PBKDF2_ITERATIONS,
  secretKey?: Uint8Array,
): Promise<Uint8Array> {
  const pw = utf8Encode(password.normalize('NFKC'))
  const stretched = typeof cost === 'number'
    ? await pbkdf2Sha256(pw, salt, cost, KEY_BYTES)
    : await argon2id(pw, salt, cost, KEY_BYTES)
  pw.fill(0)
  if (!secretKey) return stretched
  const master = await mixSecretKey(stretched, secretKey)
  stretched.fill(0)
  return master
}

/** HKDF with an empty salt: the input keying material is already the output of
 *  600,000 PBKDF2 iterations over a salted password, so the extract step has
 *  nothing further to add. RFC 5869 permits this and test case A.3 covers it. */
async function branch(masterKey: Uint8Array, info: string): Promise<Uint8Array> {
  return hkdfSha256(masterKey, new Uint8Array(0), utf8Encode(info), KEY_BYTES)
}

export async function deriveKek(masterKey: Uint8Array): Promise<Uint8Array> {
  return branch(masterKey, INFO_KEK)
}

export async function deriveAuthKey(masterKey: Uint8Array): Promise<Uint8Array> {
  return branch(masterKey, INFO_AUTH)
}

export async function deriveRecoveryKek(recoveryKey: Uint8Array): Promise<Uint8Array> {
  return branch(recoveryKey, INFO_RECOVERY)
}

export async function deriveRecoveryAuthKey(recoveryKey: Uint8Array): Promise<Uint8Array> {
  return branch(recoveryKey, INFO_RECOVERY_AUTH)
}

export async function wrapVaultKey(
  vaultKey: Uint8Array,
  kek: Uint8Array,
  purpose: 'master' | 'recovery',
): Promise<string> {
  const aad = utf8Encode(purpose === 'master' ? AAD_WRAP_MASTER : AAD_WRAP_RECOVERY)
  return seal(kek, vaultKey, aad)
}

export async function unwrapVaultKey(
  wrapped: string,
  kek: Uint8Array,
  purpose: 'master' | 'recovery',
): Promise<Uint8Array> {
  const aad = utf8Encode(purpose === 'master' ? AAD_WRAP_MASTER : AAD_WRAP_RECOVERY)
  return unseal(kek, wrapped, aad)
}

// ── Account-level operations ────────────────────────────────────────────────

/** Everything registration produces. `vaultKey` stays in memory; `recoveryKey`
 *  is shown to the user once and never transmitted; the rest is sent to the
 *  server, which can do nothing useful with any of it. */
export interface NewAccount {
  kdf: KdfParams
  /** base64url. The only password-derived value the server ever receives. */
  authKey: string
  wrappedVaultKey: string
  wrappedVaultKeyForRecovery: string
  /** base64url. Proves possession of the recovery key without revealing it,
   *  so the server can release the recovery-wrapped vault key. */
  recoveryAuthKey: string
  /** Crockford base32, hyphenated. Display once, then discard. */
  recoveryKey: string
  vaultKey: Uint8Array
}

export async function createAccount(
  password: string,
  cost: KdfCost = ARGON2_DEFAULT,
  secretKey?: Uint8Array,
): Promise<NewAccount> {
  const salt = generateSalt()
  const vaultKey = generateVaultKey()
  const recoveryKey = generateRecoveryKey()

  const masterKey = await deriveMasterKey(password, salt, cost, secretKey)
  const [kek, authKey, recoveryKek, recoveryAuthKey] = await Promise.all([
    deriveKek(masterKey),
    deriveAuthKey(masterKey),
    deriveRecoveryKek(recoveryKey),
    deriveRecoveryAuthKey(recoveryKey),
  ])
  const [wrappedVaultKey, wrappedVaultKeyForRecovery] = await Promise.all([
    wrapVaultKey(vaultKey, kek, 'master'),
    wrapVaultKey(vaultKey, recoveryKek, 'recovery'),
  ])

  return {
    kdf: kdfParams(salt, cost, secretKey),
    authKey: toBase64Url(authKey),
    wrappedVaultKey,
    wrappedVaultKeyForRecovery,
    recoveryAuthKey: toBase64Url(recoveryAuthKey),
    recoveryKey: toRecoveryString(recoveryKey),
    vaultKey,
  }
}

/** Prove possession of a recovery key, so the server will release the
 *  recovery-wrapped vault key. Derived from the recovery key alone — the master
 *  password is by definition unavailable when this is used. */
export async function deriveRecoveryProof(recoveryKey: string): Promise<string> {
  return toBase64Url(await deriveRecoveryAuthKey(fromRecoveryString(recoveryKey)))
}

export interface Unlocked {
  vaultKey: Uint8Array
  /** base64url, to present to the server as proof of the password. */
  authKey: string
}

/** The two values a login needs, in the order a login actually needs them.
 *
 *  `unlock` below takes the wrapped vault key as an argument, which suits a
 *  caller that already has it. A browser does not: it must send the Auth Key
 *  first and receives the wrapped key in the reply. Deriving both here, from
 *  one pass of the KDF, is what lets a client do that without running 600,000
 *  iterations twice. */
export interface LoginKeys {
  /** base64url. Sent to the server. */
  authKey: string
  /** Unwraps the vault key once the server returns it. Stays on the device. */
  kek: Uint8Array
}

export async function deriveLoginKeys(
  password: string,
  salt: Uint8Array,
  cost: KdfCost = PBKDF2_ITERATIONS,
  secretKey?: Uint8Array,
): Promise<LoginKeys> {
  const masterKey = await deriveMasterKey(password, salt, cost, secretKey)
  const [kek, authKey] = await Promise.all([deriveKek(masterKey), deriveAuthKey(masterKey)])
  return { authKey: toBase64Url(authKey), kek }
}

/** Derive both branches and unwrap the Vault Key. Throws UnsealError when the
 *  password is wrong, because the wrapped key then fails its authentication
 *  tag — the client can therefore reject a bad password without asking the
 *  server anything. */
export async function unlock(
  password: string,
  kdf: KdfParams,
  wrappedVaultKey: string,
  salt: Uint8Array,
  secretKey?: Uint8Array,
): Promise<Unlocked> {
  if (kdf.version === 2 && !secretKey) throw new Error('This account needs its secret key.')
  const masterKey = await deriveMasterKey(password, salt, costOf(kdf), kdf.version === 2 ? secretKey : undefined)
  const [kek, authKey] = await Promise.all([deriveKek(masterKey), deriveAuthKey(masterKey)])
  const vaultKey = await unwrapVaultKey(wrappedVaultKey, kek, 'master')
  return { vaultKey, authKey: toBase64Url(authKey) }
}

export async function unlockWithRecoveryKey(
  recoveryKey: string,
  wrappedVaultKeyForRecovery: string,
): Promise<Uint8Array> {
  const kek = await deriveRecoveryKek(fromRecoveryString(recoveryKey))
  return unwrapVaultKey(wrappedVaultKeyForRecovery, kek, 'recovery')
}

/** What a master password change produces. The Vault Key is deliberately not
 *  among these values: it does not change, so no entry is re-encrypted and
 *  password history survives. */
export interface ChangedPassword {
  kdf: KdfParams
  authKey: string
  wrappedVaultKey: string
}

export async function changePassword(
  newPassword: string,
  vaultKey: Uint8Array,
  cost: KdfCost = ARGON2_DEFAULT,
  secretKey?: Uint8Array,
): Promise<ChangedPassword> {
  const salt = generateSalt()
  const masterKey = await deriveMasterKey(newPassword, salt, cost, secretKey)
  const [kek, authKey] = await Promise.all([deriveKek(masterKey), deriveAuthKey(masterKey)])
  return {
    kdf: kdfParams(salt, cost, secretKey),
    authKey: toBase64Url(authKey),
    wrappedVaultKey: await wrapVaultKey(vaultKey, kek, 'master'),
  }
}

/** Issue a replacement recovery key, invalidating the previous one by
 *  overwriting the blob it unwraps. Requires an unlocked vault. */
export async function rotateRecoveryKey(
  vaultKey: Uint8Array,
): Promise<{ recoveryKey: string; wrappedVaultKeyForRecovery: string; recoveryAuthKey: string }> {
  const recoveryKey = generateRecoveryKey()
  const [kek, authKey] = await Promise.all([
    deriveRecoveryKek(recoveryKey),
    deriveRecoveryAuthKey(recoveryKey),
  ])
  return {
    recoveryKey: toRecoveryString(recoveryKey),
    wrappedVaultKeyForRecovery: await wrapVaultKey(vaultKey, kek, 'recovery'),
    recoveryAuthKey: toBase64Url(authKey),
  }
}
