// TOTP, RFC 6238, over HOTP's dynamic truncation from RFC 4226.
//
// TOTP secrets belong to the sites they authenticate to, so they are stored
// inside the encrypted entry blob and only ever decoded in memory here.

import { fromBase32Secret } from './encoding.js'
import { type HashName, hmac } from './primitives.js'

export type TotpAlgorithm = HashName

export interface TotpConfig {
  algorithm: TotpAlgorithm
  digits: number
  /** Seconds per step. Effectively always 30 in the wild. */
  period: number
}

export const TOTP_DEFAULTS: TotpConfig = {
  algorithm: 'SHA-1',
  digits: 6,
  period: 30,
}

export interface TotpCode {
  code: string
  /** Seconds until the current code expires, for the countdown ring. */
  secondsRemaining: number
}

export async function totpFromBytes(
  secret: Uint8Array,
  atMs: number = Date.now(),
  config: Partial<TotpConfig> = {},
): Promise<TotpCode> {
  const { algorithm, digits, period } = { ...TOTP_DEFAULTS, ...config }
  if (digits < 6 || digits > 10) throw new Error('TOTP digits must be between 6 and 10')
  if (period < 1) throw new Error('TOTP period must be at least 1 second')
  if (secret.length === 0) throw new Error('TOTP secret is empty')

  const epochSeconds = Math.floor(atMs / 1000)
  const counter = Math.floor(epochSeconds / period)

  // 8-byte big-endian counter. Split across two 32-bit halves because a
  // JavaScript bitwise operation would truncate a value this size.
  const counterBytes = new Uint8Array(8)
  new DataView(counterBytes.buffer).setBigUint64(0, BigInt(counter), false)

  const digest = await hmac(algorithm, secret, counterBytes)

  // RFC 4226 dynamic truncation: the low nibble of the final byte selects a
  // four-byte window, whose top bit is cleared to keep the value positive.
  const offset = digest[digest.length - 1]! & 0x0f
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff)

  const code = (binary % 10 ** digits).toString().padStart(digits, '0')
  return { code, secondsRemaining: period - (epochSeconds % period) }
}

export async function generateTotp(
  secretBase32: string,
  atMs: number = Date.now(),
  config: Partial<TotpConfig> = {},
): Promise<TotpCode> {
  return totpFromBytes(fromBase32Secret(secretBase32), atMs, config)
}

export interface ParsedOtpauth {
  secret: string
  config: TotpConfig
  issuer?: string
  account?: string
}

/** Parse an `otpauth://totp/...` URI, which is what a QR code contains.
 *  Unknown or absent parameters fall back to the RFC defaults, matching what
 *  authenticator apps do. */
export function parseOtpauthUri(uri: string): ParsedOtpauth {
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    throw new Error('not a valid otpauth URI')
  }
  if (url.protocol !== 'otpauth:') throw new Error('not an otpauth URI')
  if (url.host.toLowerCase() !== 'totp') throw new Error('only TOTP URIs are supported')

  const secret = url.searchParams.get('secret')
  if (!secret) throw new Error('otpauth URI has no secret')

  const rawAlgorithm = (url.searchParams.get('algorithm') ?? 'SHA1').toUpperCase()
  const algorithm: TotpAlgorithm =
    rawAlgorithm === 'SHA256' ? 'SHA-256' : rawAlgorithm === 'SHA512' ? 'SHA-512' : 'SHA-1'

  const digits = Number.parseInt(url.searchParams.get('digits') ?? '6', 10)
  const period = Number.parseInt(url.searchParams.get('period') ?? '30', 10)

  // The path label is "Issuer:account" or just "account"; the issuer query
  // parameter wins when both are present.
  const label = decodeURIComponent(url.pathname.replace(/^\//, ''))
  const [labelIssuer, labelAccount] = label.includes(':')
    ? [label.slice(0, label.indexOf(':')), label.slice(label.indexOf(':') + 1)]
    : [undefined, label]

  const issuer = url.searchParams.get('issuer') ?? labelIssuer
  const result: ParsedOtpauth = {
    secret,
    config: {
      algorithm,
      digits: Number.isNaN(digits) ? 6 : digits,
      period: Number.isNaN(period) ? 30 : period,
    },
  }
  if (issuer) result.issuer = issuer
  if (labelAccount) result.account = labelAccount
  return result
}
