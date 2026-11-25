// A software WebAuthn authenticator for tests: ES256, attestation "none".
// Produces the same JSON a browser's navigator.credentials returns, so the
// server's real verification (@simplewebauthn) runs against it.

import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'

// ── Minimal CBOR (just what WebAuthn needs) ──────────────────────────────
function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n])
  if (n < 256) return Buffer.from([(major << 5) | 24, n])
  if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b
}
type Cbor = number | string | Buffer | Map<Cbor, Cbor> | Record<string, unknown>
function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v)
  if (typeof v === 'string') { const s = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, s.length), s]) }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v])
  const entries = v instanceof Map ? [...v.entries()] : Object.entries(v)
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, val]) => [cbor(k as Cbor), cbor(val as Cbor)])])
}

const b64u = (b: Buffer) => b.toString('base64url')
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest()

export class SoftAuthenticator {
  readonly id = randomBytes(16)
  private readonly key: KeyObject
  private readonly pub: { x: Buffer; y: Buffer }
  private counter = 0

  constructor(private readonly origin = 'https://vault.test') {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    this.key = privateKey
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
    this.pub = { x: Buffer.from(jwk.x, 'base64url'), y: Buffer.from(jwk.y, 'base64url') }
  }

  private get rpIdHash() { return sha256(new URL(this.origin).hostname) }

  /** The answer to navigator.credentials.create(options). */
  register(options: { challenge: string }, opts: { uv?: boolean } = {}): Record<string, unknown> {
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: this.origin, crossOrigin: false }))
    const cose = cbor(new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, this.pub.x], [-3, this.pub.y]]))
    const idLen = Buffer.alloc(2); idLen.writeUInt16BE(this.id.length)
    const counter = Buffer.alloc(4)
    const authData = Buffer.concat([this.rpIdHash, Buffer.from([opts.uv ? 0x45 : 0x41]), counter, Buffer.alloc(16), idLen, this.id, cose])
    const attestationObject = cbor({ fmt: 'none', attStmt: new Map(), authData })
    return {
      id: b64u(this.id), rawId: b64u(this.id), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientData), attestationObject: b64u(attestationObject), transports: ['usb'] },
    }
  }

  /** The answer to navigator.credentials.get(options). */
  assert(options: { challenge: string }, opts: { origin?: string; uv?: boolean; userHandle?: string } = {}): Record<string, unknown> {
    this.counter++
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: opts.origin ?? this.origin, crossOrigin: false }))
    const counter = Buffer.alloc(4); counter.writeUInt32BE(this.counter)
    const authData = Buffer.concat([this.rpIdHash, Buffer.from([opts.uv ? 0x05 : 0x01]), counter])
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientData)]), this.key)
    return {
      id: b64u(this.id), rawId: b64u(this.id), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(signature), ...(opts.userHandle !== undefined ? { userHandle: b64u(Buffer.from(opts.userHandle, 'utf8')) } : {}) },
    }
  }
}
