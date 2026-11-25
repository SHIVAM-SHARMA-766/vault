// Argon2id (RFC 9106, version 0x13), for the master password (decisions/0028).
//
// The memory-hard filling runs in a small WebAssembly module assembled from
// ../argon2/argon2.wat, our own source, embedded in argon2-wasm.ts (no fetch,
// no CDN). The rest of the algorithm, which hashes a few kilobytes, is here:
// BLAKE2b, the variable-length hash H', the first blocks and the final tag.
//
// Each call instantiates the module afresh and zeroes its memory before
// letting go of it, so 64 MiB of password-derived blocks do not linger in a
// cached instance.

import { ARGON2_WASM_BASE64 } from './argon2-wasm.js'

// ── BLAKE2b (RFC 7693), unkeyed, any output length up to 64 ───────────────

const MASK = (1n << 64n) - 1n
const IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
]
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
] as const

const rotr = (x: bigint, n: bigint) => ((x >> n) | (x << (64n - n))) & MASK

function compress(h: bigint[], block: Uint8Array, t: bigint, last: boolean): void {
  const view = new DataView(block.buffer, block.byteOffset, 128)
  const m: bigint[] = []
  for (let i = 0; i < 16; i++) m.push(view.getBigUint64(i * 8, true))
  const v = [...h, ...IV]
  v[12] = v[12]! ^ (t & MASK)
  v[13] = v[13]! ^ (t >> 64n)
  if (last) v[14] = v[14]! ^ MASK
  const g = (a: number, b: number, c: number, d: number, x: bigint, y: bigint) => {
    v[a] = (v[a]! + v[b]! + x) & MASK; v[d] = rotr(v[d]! ^ v[a]!, 32n)
    v[c] = (v[c]! + v[d]!) & MASK; v[b] = rotr(v[b]! ^ v[c]!, 24n)
    v[a] = (v[a]! + v[b]! + y) & MASK; v[d] = rotr(v[d]! ^ v[a]!, 16n)
    v[c] = (v[c]! + v[d]!) & MASK; v[b] = rotr(v[b]! ^ v[c]!, 63n)
  }
  for (let r = 0; r < 12; r++) {
    const s = SIGMA[r % 10]!
    g(0, 4, 8, 12, m[s[0]]!, m[s[1]]!); g(1, 5, 9, 13, m[s[2]]!, m[s[3]]!)
    g(2, 6, 10, 14, m[s[4]]!, m[s[5]]!); g(3, 7, 11, 15, m[s[6]]!, m[s[7]]!)
    g(0, 5, 10, 15, m[s[8]]!, m[s[9]]!); g(1, 6, 11, 12, m[s[10]]!, m[s[11]]!)
    g(2, 7, 8, 13, m[s[12]]!, m[s[13]]!); g(3, 4, 9, 14, m[s[14]]!, m[s[15]]!)
  }
  for (let i = 0; i < 8; i++) h[i] = h[i]! ^ v[i]! ^ v[i + 8]!
}

export function blake2b(input: Uint8Array, outLen: number): Uint8Array {
  if (!Number.isInteger(outLen) || outLen < 1 || outLen > 64) throw new Error('BLAKE2b output is 1 to 64 bytes.')
  const h = [...IV]
  h[0] = h[0]! ^ (0x01010000n | BigInt(outLen))
  const block = new Uint8Array(128)
  let t = 0n
  let offset = 0
  // Every full block but the last is compressed as it comes; the last one
  // (full or partial, or empty input) carries the final flag.
  while (input.length - offset > 128) {
    t += 128n
    compress(h, input.subarray(offset, offset + 128), t, false)
    offset += 128
  }
  block.fill(0)
  block.set(input.subarray(offset))
  t += BigInt(input.length - offset)
  compress(h, block, t, true)
  const out = new Uint8Array(64)
  const view = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) view.setBigUint64(i * 8, h[i]!, true)
  block.fill(0)
  return out.slice(0, outLen)
}

// ── Argon2id ──────────────────────────────────────────────────────────────

const le32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b }
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

/** H' (RFC 9106, 3.3): BLAKE2b stretched to any length. */
function hPrime(outLen: number, x: Uint8Array): Uint8Array {
  const input = concat(le32(outLen), x)
  if (outLen <= 64) return blake2b(input, outLen)
  const out = new Uint8Array(outLen)
  const r = Math.ceil(outLen / 32) - 2
  let v = blake2b(input, 64)
  out.set(v.subarray(0, 32), 0)
  for (let i = 1; i < r; i++) {
    v = blake2b(v, 64)
    out.set(v.subarray(0, 32), i * 32)
  }
  out.set(blake2b(v, outLen - 32 * r), 32 * r)
  return out
}

export interface Argon2Params {
  /** Memory in KiB. */
  m: number
  /** Passes over memory. */
  t: number
  /** Lanes. */
  p: number
}

let compiled: Promise<WebAssembly.Module> | null = null
function wasmModule(): Promise<WebAssembly.Module> {
  if (!compiled) {
    const bin = atob(ARGON2_WASM_BASE64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    compiled = WebAssembly.compile(bytes)
  }
  return compiled
}

/** Whether this page may run the module. A Content-Security-Policy without
 *  'wasm-unsafe-eval' (an old reverse-proxy config, say) refuses to compile
 *  it; callers then make new keys with PBKDF2 instead of failing. */
export async function argon2Supported(): Promise<boolean> {
  try {
    await WebAssembly.instantiate(await wasmModule())
    return true
  } catch {
    compiled = null
    return false
  }
}

const BASE = 8192
const BLOCK = 1024

export async function argon2id(
  password: Uint8Array, salt: Uint8Array, params: Argon2Params, outLen = 32,
  extra: { secret?: Uint8Array; ad?: Uint8Array } = {},
): Promise<Uint8Array> {
  const { m, t, p } = params
  if (!Number.isInteger(p) || p < 1 || p > 255) throw new Error('Argon2 lanes must be 1 to 255.')
  if (!Number.isInteger(t) || t < 1) throw new Error('Argon2 needs at least one pass.')
  if (!Number.isInteger(m) || m < 8 * p || m > 4 * 1024 * 1024) throw new Error('Argon2 memory must be at least 8 KiB per lane and at most 4 GiB.')
  if (!Number.isInteger(outLen) || outLen < 4) throw new Error('Argon2 output must be at least 4 bytes.')
  if (salt.length < 8) throw new Error('Argon2 salt must be at least 8 bytes.')

  const secret = extra.secret ?? new Uint8Array(0)
  const ad = extra.ad ?? new Uint8Array(0)
  const h0 = blake2b(concat(
    le32(p), le32(outLen), le32(m), le32(t), le32(0x13), le32(2),
    le32(password.length), password, le32(salt.length), salt,
    le32(secret.length), secret, le32(ad.length), ad,
  ), 64)

  const laneLen = Math.floor(m / (4 * p)) * 4
  const segLen = laneLen / 4
  const blocks = laneLen * p

  const instance = await WebAssembly.instantiate(await wasmModule())
  const exports = instance.exports as { memory: WebAssembly.Memory; fill: (lanes: number, laneLen: number, segLen: number, passes: number) => void }
  const need = Math.ceil((BASE + blocks * BLOCK) / 65536)
  const have = exports.memory.buffer.byteLength / 65536
  if (need > have) exports.memory.grow(need - have)
  const mem = new Uint8Array(exports.memory.buffer)
  try {
    for (let lane = 0; lane < p; lane++) {
      for (const j of [0, 1]) {
        const seed = concat(h0, le32(j), le32(lane))
        const b = hPrime(BLOCK, seed)
        mem.set(b, BASE + (lane * laneLen + j) * BLOCK)
        b.fill(0); seed.fill(0)
      }
    }
    exports.fill(p, laneLen, segLen, t)
    const c = new Uint8Array(BLOCK)
    for (let lane = 0; lane < p; lane++) {
      const at = BASE + (lane * laneLen + laneLen - 1) * BLOCK
      for (let k = 0; k < BLOCK; k++) c[k] = c[k]! ^ mem[at + k]!
    }
    const tag = hPrime(outLen, c)
    c.fill(0)
    return tag
  } finally {
    new Uint8Array(exports.memory.buffer).fill(0)
    h0.fill(0)
  }
}
