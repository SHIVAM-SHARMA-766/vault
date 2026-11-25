// Passkeys kept in Vault (decisions/0022 (c), 0035): the byte formats a
// WebAuthn authenticator produces, for the browser extension to answer
// navigator.credentials on a site's behalf. Pure functions over bytes; the
// signing itself is WebCrypto's, in the extension's background.
//
//   authenticatorData = SHA-256(rpId) ‖ flags ‖ signCount(4) [‖ attested credential data]
//   attestationObject = CBOR { fmt: "none", attStmt: {}, authData }
//   signature         = ECDSA-P256-SHA256(authenticatorData ‖ SHA-256(clientDataJSON)), DER
//
// The sign count stays 0: a passkey that syncs between devices has no single
// counter, and 0 tells the site so (WebAuthn §6.1.1).

import { registrableDomain } from './sitematch.js'

/** A passkey as stored inside a sealed vault item. */
export interface StoredPasskey {
  /** base64url, 16 random bytes. */
  credentialId: string
  rpId: string
  /** base64url, the site's user handle. */
  userHandle: string
  userName: string
  userDisplayName?: string
  /** base64url PKCS#8, ECDSA P-256. Encrypted with the rest of the item. */
  privateKey: string
  /** base64url SubjectPublicKeyInfo, for getPublicKey(). */
  publicKey: string
  /** base64url COSE_Key. */
  cosePublicKey: string
  alg: -7
  createdAt: string
}

// ── CBOR (RFC 8949), the subset WebAuthn needs ─────────────────────────────

type Cbor = number | string | Uint8Array | Map<Cbor, Cbor> | { [k: string]: Cbor }

function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n]
  if (n < 0x100) return [(major << 5) | 24, n]
  if (n < 0x10000) return [(major << 5) | 25, n >> 8, n & 0xff]
  return [(major << 5) | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

export function cbor(v: Cbor): Uint8Array {
  const out: number[] = []
  const put = (x: Cbor) => {
    if (typeof x === 'number') {
      if (!Number.isInteger(x)) throw new Error('CBOR: integers only')
      out.push(...(x >= 0 ? head(0, x) : head(1, -1 - x)))
    } else if (typeof x === 'string') {
      const b = new TextEncoder().encode(x)
      out.push(...head(3, b.length), ...b)
    } else if (x instanceof Uint8Array) {
      out.push(...head(2, x.length), ...x)
    } else {
      const entries = x instanceof Map ? [...x.entries()] : Object.entries(x)
      out.push(...head(5, entries.length))
      for (const [k, val] of entries) { put(k); put(val) }
    }
  }
  put(v)
  return new Uint8Array(out)
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

/** The COSE_Key for an ES256 public key (x and y, 32 bytes each). */
export function coseEs256(x: Uint8Array, y: Uint8Array): Uint8Array {
  if (x.length !== 32 || y.length !== 32) throw new Error('P-256 coordinates are 32 bytes')
  return cbor(new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, x], [-3, y]]))
}

export const FLAGS = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40 } as const

/** authenticatorData. `attested` adds the credential (registration only).
 *  Vault's passkeys are backed up with the vault: BE and BS are set. */
export function authenticatorData(rpIdHash: Uint8Array, attested?: { credentialId: Uint8Array; cosePublicKey: Uint8Array }): Uint8Array {
  if (rpIdHash.length !== 32) throw new Error('rpIdHash is 32 bytes')
  const flags = FLAGS.UP | FLAGS.UV | FLAGS.BE | FLAGS.BS | (attested ? FLAGS.AT : 0)
  const base = concat(rpIdHash, new Uint8Array([flags]), new Uint8Array(4))
  if (!attested) return base
  const id = attested.credentialId
  // AAGUID: all zeros, as for "none" attestation; no device model is claimed.
  return concat(base, new Uint8Array(16), new Uint8Array([id.length >> 8, id.length & 0xff]), id, attested.cosePublicKey)
}

export function attestationObject(authData: Uint8Array): Uint8Array {
  return cbor(new Map<Cbor, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))
}

/** WebCrypto signs ECDSA as r ‖ s; WebAuthn wants an ASN.1 DER sequence. */
export function p1363ToDer(sig: Uint8Array): Uint8Array {
  if (sig.length !== 64) throw new Error('an ES256 signature is 64 bytes')
  const int = (b: Uint8Array) => {
    let i = 0
    while (i < b.length - 1 && b[i] === 0) i++
    let v = b.subarray(i)
    if (v[0]! & 0x80) v = concat(new Uint8Array([0]), v)
    return concat(new Uint8Array([0x02, v.length]), v)
  }
  const body = concat(int(sig.subarray(0, 32)), int(sig.subarray(32)))
  return concat(new Uint8Array([0x30, body.length]), body)
}

/** clientDataJSON, with the origin the browser reported for the tab, never
 *  one the page supplied. */
export function clientDataJSON(type: 'webauthn.create' | 'webauthn.get', challenge: string, origin: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }))
}

/** Whether a page at `origin` may use `rpId` (WebAuthn §5.1.3 and §5.1.4):
 *  a secure origin whose host is the rpId or a subdomain of it, where the
 *  rpId is not a public suffix. `localhost` is allowed as itself, as
 *  browsers allow it. */
export function rpIdAllowed(origin: string, rpId: string): boolean {
  let u: URL
  try { u = new URL(origin) } catch { return false }
  const host = u.hostname.toLowerCase()
  const rp = rpId.toLowerCase().replace(/\.$/, '')
  if (!rp || rp.length > 253) return false
  const local = host === 'localhost' || host.endsWith('.localhost')
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return false
  if (local) return rp === host || (host.endsWith(`.${rp}`) && rp.endsWith('localhost'))
  if (host !== rp && !host.endsWith(`.${rp}`)) return false
  const reg = registrableDomain(rp)
  return reg !== null && (rp === reg || rp.endsWith(`.${reg}`))
}

// ── Making and using a passkey (WebCrypto) ─────────────────────────────────

const b64u = (b: Uint8Array) => {
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const fromB64u = (s: string) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource))

/** What the page gets back, with every binary field base64url. */
export interface AttestationJSON { id: string; clientDataJSON: string; attestationObject: string; authenticatorData: string; publicKey: string; publicKeyAlgorithm: -7; transports: string[] }
export interface AssertionJSON { id: string; clientDataJSON: string; authenticatorData: string; signature: string; userHandle: string }

/** A new ES256 passkey for `rpId`, and the registration response for it. */
export async function createPasskey(input: { rpId: string; origin: string; challenge: string; userHandle: string; userName: string; userDisplayName?: string; now?: Date }): Promise<{ stored: StoredPasskey; response: AttestationJSON }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair
  const [pkcs8, spki, jwk] = await Promise.all([
    crypto.subtle.exportKey('pkcs8', pair.privateKey), crypto.subtle.exportKey('spki', pair.publicKey), crypto.subtle.exportKey('jwk', pair.publicKey),
  ])
  const credentialId = crypto.getRandomValues(new Uint8Array(16))
  const cose = coseEs256(fromB64u(jwk.x!), fromB64u(jwk.y!))
  const authData = authenticatorData(await sha256(new TextEncoder().encode(input.rpId)), { credentialId, cosePublicKey: cose })
  const stored: StoredPasskey = {
    credentialId: b64u(credentialId), rpId: input.rpId, userHandle: input.userHandle, userName: input.userName,
    ...(input.userDisplayName ? { userDisplayName: input.userDisplayName } : {}),
    privateKey: b64u(new Uint8Array(pkcs8)), publicKey: b64u(new Uint8Array(spki)), cosePublicKey: b64u(cose), alg: -7,
    createdAt: (input.now ?? new Date()).toISOString(),
  }
  return {
    stored,
    response: {
      id: stored.credentialId, clientDataJSON: b64u(clientDataJSON('webauthn.create', input.challenge, input.origin)),
      attestationObject: b64u(attestationObject(authData)), authenticatorData: b64u(authData),
      publicKey: stored.publicKey, publicKeyAlgorithm: -7, transports: ['internal', 'hybrid'],
    },
  }
}

/** Signs in with a stored passkey: the assertion for this origin and challenge. */
export async function assertPasskey(p: StoredPasskey, input: { origin: string; challenge: string }): Promise<AssertionJSON> {
  const key = await crypto.subtle.importKey('pkcs8', fromB64u(p.privateKey) as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const authData = authenticatorData(await sha256(new TextEncoder().encode(p.rpId)))
  const client = clientDataJSON('webauthn.get', input.challenge, input.origin)
  const signed = new Uint8Array(authData.length + 32)
  signed.set(authData)
  signed.set(await sha256(client), authData.length)
  const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, signed as BufferSource))
  return { id: p.credentialId, clientDataJSON: b64u(client), authenticatorData: b64u(authData), signature: b64u(p1363ToDer(raw)), userHandle: p.userHandle }
}
