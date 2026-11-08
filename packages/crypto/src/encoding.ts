// Byte/string conversions. Implemented explicitly rather than via platform
// helpers (btoa, Buffer) so that behaviour is identical in the browser and in
// Node, and so that nothing here depends on a global that may be absent.

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** Crockford base32: no I, L, O, or U, so the alphabet has no character pairs
 *  a human can confuse when transcribing a recovery key by hand. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** RFC 4648 base32 — the encoding TOTP secrets use. Distinct from Crockford. */
const BASE32_RFC4648 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

import { forgetKey } from './keycache.js'

export function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

export function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hex string must have even length')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) throw new Error('invalid hex string')
    out[i] = byte
  }
  return out
}

export function toBase64Url(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]
    out += B64URL[b0 >> 2]
    out += B64URL[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]
    if (b1 === undefined) break
    out += B64URL[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]
    if (b2 === undefined) break
    out += B64URL[b2 & 0x3f]
  }
  return out
}

export function fromBase64Url(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '')
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8))
  let acc = 0
  let bits = 0
  let pos = 0
  for (const ch of clean) {
    const v = B64URL.indexOf(ch)
    if (v === -1) throw new Error('invalid base64url string')
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[pos++] = (acc >> bits) & 0xff
    }
  }
  return out
}

function base32Encode(bytes: Uint8Array, alphabet: string): string {
  let out = ''
  let acc = 0
  let bits = 0
  for (const b of bytes) {
    acc = (acc << 8) | b
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += alphabet[(acc >> bits) & 0x1f]
    }
  }
  if (bits > 0) out += alphabet[(acc << (5 - bits)) & 0x1f]
  return out
}

function base32Decode(text: string, alphabet: string): Uint8Array {
  const bytes: number[] = []
  let acc = 0
  let bits = 0
  for (const ch of text) {
    const v = alphabet.indexOf(ch)
    if (v === -1) throw new Error(`invalid base32 character: ${ch}`)
    acc = (acc << 5) | v
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((acc >> bits) & 0xff)
    }
  }
  return new Uint8Array(bytes)
}

/** Encode as Crockford base32, hyphenated every 4 characters for legibility.
 *  Used for the recovery key, which a person has to write down and type back. */
export function toRecoveryString(bytes: Uint8Array): string {
  const raw = base32Encode(bytes, CROCKFORD)
  return (raw.match(/.{1,4}/g) ?? []).join('-')
}

/** Inverse of toRecoveryString, tolerant of how people actually retype things:
 *  any case, any grouping, and the Crockford substitutions for characters that
 *  look alike (I and L read as 1, O reads as 0). */
export function fromRecoveryString(text: string): Uint8Array {
  const normalized = text
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
  if (normalized.length === 0) throw new Error('recovery key is empty')
  return base32Decode(normalized, CROCKFORD)
}

/** Decode an RFC 4648 base32 TOTP secret. Padding, spaces, and lower case are
 *  all common in secrets copied from other applications, so all are accepted. */
export function fromBase32Secret(text: string): Uint8Array {
  const normalized = text.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '')
  return base32Decode(normalized, BASE32_RFC4648)
}

export function toBase32Secret(bytes: Uint8Array): string {
  return base32Encode(bytes, BASE32_RFC4648)
}

/** Compare in time independent of where the first difference falls, so that
 *  comparing a secret against an attacker-supplied value leaks nothing. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

/** Overwrite key material once it is no longer needed. This is best-effort:
 *  JavaScript engines may have copied the bytes during garbage collection, and
 *  nothing here can reach those copies. Worth doing, not worth relying on. */
export function wipe(bytes: Uint8Array): void {
  bytes.fill(0)
  forgetKey(bytes)
}
