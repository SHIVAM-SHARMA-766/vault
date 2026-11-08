// Signing keys and signed key grants (decisions/0025). Each account has an
// ECDSA P-256 key pair beside its ECDH identity key (one key, one purpose).
// An admin signs each collection key grant; a member's app verifies the
// signature against an admin it trusts before using the key, so a server can
// no longer hand a member a key of its own choosing (threat A15).

import { seal, unseal } from './aead.js'
import { fromBase64Url, toBase64Url, toHex, utf8Encode, wipe } from './encoding.js'
import { buf, subtle } from './primitives.js'

const ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const
const AAD_SIGNING_PRIVATE = utf8Encode('vault.identity.signing.v1')

export interface SigningKeyPair {
  /** Raw uncompressed point, 65 bytes. */
  publicKey: Uint8Array
  /** PKCS#8. Sealed under the vault key before it leaves the device. */
  privateKey: Uint8Array
}

export async function generateSigningKeyPair(): Promise<SigningKeyPair> {
  const pair = await subtle().generateKey(ALG, true, ['sign', 'verify'])
  return {
    publicKey: new Uint8Array(await subtle().exportKey('raw', pair.publicKey)),
    privateKey: new Uint8Array(await subtle().exportKey('pkcs8', pair.privateKey)),
  }
}

export const wrapSigningPrivateKey = (privateKey: Uint8Array, vaultKey: Uint8Array) => seal(vaultKey, privateKey, AAD_SIGNING_PRIVATE)
export const unwrapSigningPrivateKey = (wrapped: string, vaultKey: Uint8Array) => unseal(vaultKey, wrapped, AAD_SIGNING_PRIVATE)

/** The fingerprint people compare, covering both public keys: SHA-256 of
 *  the ECDH key then the signing key, first 128 bits, eight groups of four. */
export async function fullFingerprint(ecdhPublic: Uint8Array, signingPublic: Uint8Array): Promise<string> {
  const joined = new Uint8Array(ecdhPublic.length + signingPublic.length)
  joined.set(ecdhPublic); joined.set(signingPublic, ecdhPublic.length)
  const digest = new Uint8Array(await subtle().digest('SHA-256', buf(joined)))
  return toHex(digest.subarray(0, 16)).match(/.{4}/g)!.join(' ')
}

export interface Grant {
  orgId: string
  collectionId: string
  version: number
  /** The recipient's full fingerprint, spaces removed. */
  recipient: string
  /** The sealed key blob the grant carries. */
  keyBlob: string
}

/** The exact bytes signed. Every field is an id, a number, hex or base64url,
 *  none of which can contain "|", so the encoding is unambiguous. */
export async function grantBytes(g: Grant): Promise<Uint8Array> {
  const blobHash = toBase64Url(new Uint8Array(await subtle().digest('SHA-256', buf(utf8Encode(g.keyBlob)))))
  const parts = ['vault.grant.v1', g.orgId, g.collectionId, String(g.version), g.recipient.replace(/\s/g, ''), blobHash]
  for (const p of parts) if (p.includes('|')) throw new Error('a grant field contains "|"')
  return utf8Encode(parts.join('|'))
}

/** An owner's statement that an admin's keys are trusted to sign grants. */
export function endorsementBytes(orgId: string, adminFingerprint: string): Uint8Array {
  return utf8Encode(['vault.admin.v1', orgId, adminFingerprint.replace(/\s/g, '')].join('|'))
}

export async function signBytes(privateKey: Uint8Array, bytes: Uint8Array): Promise<string> {
  const key = await subtle().importKey('pkcs8', buf(privateKey), ALG, false, ['sign'])
  return toBase64Url(new Uint8Array(await subtle().sign(SIGN, key, buf(bytes))))
}

export async function verifyBytes(publicKey: Uint8Array, bytes: Uint8Array, signature: string): Promise<boolean> {
  try {
    const key = await subtle().importKey('raw', buf(publicKey), ALG, false, ['verify'])
    return await subtle().verify(SIGN, key, buf(fromBase64Url(signature)), buf(bytes))
  } catch {
    return false
  }
}

export const signGrant = async (privateKey: Uint8Array, g: Grant) => signBytes(privateKey, await grantBytes(g))
export const verifyGrant = async (publicKey: Uint8Array, g: Grant, signature: string) => verifyBytes(publicKey, await grantBytes(g), signature)

export { wipe }
