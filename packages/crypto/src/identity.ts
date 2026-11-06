// Identity keys: one asymmetric key pair per account.
//
// Everything before this was symmetric — one vault key, known only to its
// owner. Sharing needs a way to hand a key to someone else without the server
// learning it, and that needs public-key cryptography. Each account therefore
// has an ECDH P-256 key pair:
//
//   - the public key is stored in the clear and given to people who want to
//     share with this account;
//   - the private key is sealed under the account's vault key, so it is
//     exactly as protected as everything else in the vault and survives a
//     master password change untouched.
//
// Sealing to a recipient is ECIES built from platform primitives: a fresh
// ephemeral P-256 key per message, ECDH with the recipient's public key,
// HKDF-SHA256 to a one-time AES-256-GCM key, and AES-GCM with the caller's
// context bound in as associated data. Nothing is implemented by hand.
//
//     pk1.<base64url(ephemeral public key, 65 bytes)>.<v1 sealed blob>
//
// P-256 rather than X25519 because it is in Web Crypto in every browser this
// supports, in Node, and in Android's keystore, which a future client has to
// match exactly.
//
// Design: decisions/0009-identity-keys-and-sharing.md

import { UnsealError, seal, unseal } from './aead.js'
import { fromBase64Url, toBase64Url, toHex, utf8Encode, wipe } from './encoding.js'
import { buf, hkdfSha256, subtle } from './primitives.js'

export const IDENTITY_VERSION = 'pk1'
/** An uncompressed P-256 point: 0x04 || X || Y. */
export const PUBLIC_KEY_BYTES = 65

const AAD_IDENTITY_PRIVATE = 'vault.identity.private.v1'
const INFO_SHARE = utf8Encode('vault.share.v1')
const CURVE = { name: 'ECDH', namedCurve: 'P-256' } as const

export interface IdentityKeyPair {
  /** Raw uncompressed point, 65 bytes. Safe to publish. */
  publicKey: Uint8Array
  /** PKCS#8. Never leaves the device except sealed under the vault key. */
  privateKey: Uint8Array
}

export async function generateIdentityKeyPair(): Promise<IdentityKeyPair> {
  const pair = await subtle().generateKey(CURVE, true, ['deriveBits'])
  const publicKey = new Uint8Array(await subtle().exportKey('raw', pair.publicKey))
  const privateKey = new Uint8Array(await subtle().exportKey('pkcs8', pair.privateKey))
  return { publicKey, privateKey }
}

/** Imports a public key, which also checks that it is a valid point on the
 *  curve. A server handing out a malformed key fails here, not later. */
async function importPublic(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== PUBLIC_KEY_BYTES || raw[0] !== 0x04) throw new Error('not an uncompressed P-256 public key')
  return subtle().importKey('raw', buf(raw), CURVE, false, [])
}

async function importPrivate(pkcs8: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey('pkcs8', buf(pkcs8), CURVE, false, ['deriveBits'])
}

export async function isValidPublicKey(raw: Uint8Array): Promise<boolean> {
  try {
    await importPublic(raw)
    return true
  } catch {
    return false
  }
}

export async function wrapIdentityPrivateKey(privateKey: Uint8Array, vaultKey: Uint8Array): Promise<string> {
  return seal(vaultKey, privateKey, utf8Encode(AAD_IDENTITY_PRIVATE))
}

export async function unwrapIdentityPrivateKey(wrapped: string, vaultKey: Uint8Array): Promise<Uint8Array> {
  return unseal(vaultKey, wrapped, utf8Encode(AAD_IDENTITY_PRIVATE))
}

/** The key both sides arrive at. The salt binds both public keys, so a
 *  ciphertext cannot be replayed as if it were for a different recipient. */
async function shareKey(
  privateKey: CryptoKey, peerPublic: CryptoKey, ephemeralRaw: Uint8Array, recipientRaw: Uint8Array,
): Promise<Uint8Array> {
  const shared = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: peerPublic }, privateKey, 256))
  const salt = new Uint8Array(ephemeralRaw.length + recipientRaw.length)
  salt.set(ephemeralRaw, 0)
  salt.set(recipientRaw, ephemeralRaw.length)
  try {
    return await hkdfSha256(shared, salt, INFO_SHARE, 32)
  } finally {
    wipe(shared)
  }
}

/**
 * Encrypts `plaintext` so that only the holder of `recipientPublicKey`'s
 * private half can read it.
 *
 * `context` says what this is and where it belongs — for example
 * "collection-key:<collection id>" — and must be supplied again to open it.
 * It stops a server from presenting a ciphertext made for one purpose as if
 * it were another.
 */
export async function sealForRecipient(
  recipientPublicKey: Uint8Array, plaintext: Uint8Array, context: string,
): Promise<string> {
  if (!context) throw new Error('a context is required')
  const recipient = await importPublic(recipientPublicKey)
  const ephemeral = await subtle().generateKey(CURVE, true, ['deriveBits'])
  const ephemeralRaw = new Uint8Array(await subtle().exportKey('raw', ephemeral.publicKey))
  const key = await shareKey(ephemeral.privateKey, recipient, ephemeralRaw, recipientPublicKey)
  try {
    const sealed = await seal(key, plaintext, utf8Encode(`vault.share|${context}`))
    return `${IDENTITY_VERSION}.${toBase64Url(ephemeralRaw)}.${sealed}`
  } finally {
    wipe(key)
  }
}

/** Opens what `sealForRecipient` produced. Every failure is an UnsealError. */
export async function openFromSender(
  privateKey: Uint8Array, recipientPublicKey: Uint8Array, blob: string, context: string,
): Promise<Uint8Array> {
  const first = blob.indexOf('.')
  const second = blob.indexOf('.', first + 1)
  if (first < 0 || second < 0 || blob.slice(0, first) !== IDENTITY_VERSION) throw new UnsealError()
  let ephemeralRaw: Uint8Array
  let ephemeral: CryptoKey
  let own: CryptoKey
  try {
    ephemeralRaw = fromBase64Url(blob.slice(first + 1, second))
    ephemeral = await importPublic(ephemeralRaw)
    own = await importPrivate(privateKey)
  } catch {
    throw new UnsealError()
  }
  const key = await shareKey(own, ephemeral, ephemeralRaw, recipientPublicKey)
  try {
    return await unseal(key, blob.slice(second + 1), utf8Encode(`vault.share|${context}`))
  } finally {
    wipe(key)
  }
}

/**
 * A short, stable rendering of a public key for people to compare.
 *
 * The server hands out public keys, so a hostile server could hand out its
 * own instead and read whatever is shared to it. Comparing fingerprints out
 * of band — or an admin confirming a member's fingerprint before sharing —
 * is what closes that. Eight groups of four hex digits: 128 bits.
 */
export async function identityFingerprint(publicKey: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await subtle().digest('SHA-256', buf(publicKey)))
  return toHex(digest.subarray(0, 16)).match(/.{4}/g)!.join(' ')
}
