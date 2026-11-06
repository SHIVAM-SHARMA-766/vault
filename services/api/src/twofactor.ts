// Two-factor sign-in: TOTP (RFC 6238) and single-use recovery codes.
//
// This is the one place the server must hold a secret of the user's: to check
// a TOTP code it needs the TOTP key. That key protects sign-in, not the vault
// — the vault stays under keys only the user can derive — so holding it does
// not weaken the zero-knowledge claim. It is still not stored in the clear:
// it is sealed with AES-256-GCM under a key derived from the server pepper,
// which lives outside the database, so a database dump alone does not yield
// anyone's second factor.
//
// Recovery codes are stored as HMACs under the same pepper. Each works once.
//
// See decisions/0011-two-factor-sign-in.md.

import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { generateTotp, toBase32Secret } from '@vault/crypto'

import { HttpError } from './http.js'

export const TOTP_PERIOD_MS = 30_000
export const RECOVERY_CODE_COUNT = 10

/** Stored on the profile when two-factor sign-in is on. */
export interface TotpState {
  /** The TOTP key, sealed: `s1.<iv>.<ciphertext+tag>`. */
  secret: string
  enabledAt: string
  /** The last time step accepted, so a code cannot be used twice. */
  lastStep: number
}

const sealKey = (pepper: string) => createHmac('sha256', pepper).update('vault.totp-secret.v1').digest()

export function sealSecret(base32: string, pepper: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', sealKey(pepper), iv)
  const body = Buffer.concat([cipher.update(base32, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return `s1.${iv.toString('base64url')}.${body.toString('base64url')}`
}

export function openSecret(sealed: string, pepper: string): string {
  const [v, ivB64, bodyB64] = sealed.split('.')
  if (v !== 's1' || !ivB64 || !bodyB64) throw new Error('unrecognised sealed secret')
  const body = Buffer.from(bodyB64, 'base64url')
  const decipher = createDecipheriv('aes-256-gcm', sealKey(pepper), Buffer.from(ivB64, 'base64url'))
  decipher.setAuthTag(body.subarray(body.length - 16))
  return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString('utf8')
}

/** 160 bits, the size RFC 4226 recommends for HMAC-SHA1. */
export function newSecret(): string {
  return toBase32Secret(new Uint8Array(randomBytes(20)))
}

/**
 * Checks a six-digit code against the current step and one either side (the
 * phone's clock is rarely exact). Returns the step that matched, or null.
 * Steps at or before `lastStep` are refused, so an observed code cannot be
 * replayed within its window.
 */
export async function verifyTotp(base32: string, code: string, nowMs: number, lastStep = -1): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null
  const now = Math.floor(nowMs / TOTP_PERIOD_MS)
  let matched: number | null = null
  // Check every candidate rather than returning early, so the time taken does
  // not say which step matched.
  for (const step of [now - 1, now, now + 1]) {
    const { code: expected } = await generateTotp(base32, step * TOTP_PERIOD_MS)
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(code)) && step > lastStep) matched = step
  }
  return matched
}

// Crockford base32, as invitation codes use: nothing to misread.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
}

/** Ten codes of 50 bits each, as XXXXX-XXXXX. */
export function newRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const chars = [...randomBytes(10)].map((b) => ALPHABET[b & 31]).join('')
    return `${chars.slice(0, 5)}-${chars.slice(5)}`
  })
}

export function hashRecoveryCode(code: string, pepper: string): string {
  return createHmac('sha256', pepper).update(`vault.2fa-recovery|${normalizeRecoveryCode(code)}`).digest('base64url')
}

/** The signal a client needs to ask for the second factor. Sent only after
 *  the password has been proved, so it tells a stranger nothing. */
export const twoFactorRequired = () =>
  new HttpError(401, 'two_factor_required', 'Enter the code from your authenticator app.')
export const invalidTwoFactor = () =>
  new HttpError(401, 'invalid_two_factor', 'That code is not valid. Codes change every 30 seconds and each works once.')
