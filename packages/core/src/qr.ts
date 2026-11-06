// QR codes (ISO/IEC 18004), byte mode, for showing an otpauth:// URI to an
// authenticator app.
//
// Written here rather than taken from a package: it runs on the page that
// holds the vault key, so it is held to the same rule as everything else on
// that page — as little third-party code as possible. It follows the
// structure of Project Nayuki's reference implementation and is checked
// against an independent implementation (Python's `qrcode`) in
// test/qr.test.ts, module for module, across versions, levels and masks.

export type Ecc = 'L' | 'M' | 'Q' | 'H'

const ECC_INDEX: Record<Ecc, number> = { L: 0, M: 1, Q: 2, H: 3 }
const FORMAT_BITS: Record<Ecc, number> = { L: 1, M: 0, Q: 3, H: 2 }

// Index 0 is unused; versions run 1..40.
const ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
]
const NUM_ERROR_CORRECTION_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
]

const bit = (x: number, i: number) => ((x >>> i) & 1) !== 0

function rawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2
    result -= (25 * numAlign - 10) * numAlign - 55
    if (ver >= 7) result -= 36
  }
  return result
}

function dataCodewords(ver: number, ecc: Ecc): number {
  const e = ECC_INDEX[ecc]
  return Math.floor(rawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[e]![ver]! * NUM_ERROR_CORRECTION_BLOCKS[e]![ver]!
}

function gfMultiply(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}

function rsDivisor(degree: number): number[] {
  const result: number[] = new Array(degree - 1).fill(0)
  result.push(1)
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j]!, root)
      if (j + 1 < result.length) result[j]! ^= result[j + 1]!
    }
    root = gfMultiply(root, 0x02)
  }
  return result
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = divisor.map(() => 0)
  for (const b of data) {
    const factor = b ^ result.shift()!
    result.push(0)
    divisor.forEach((coef, i) => { result[i]! ^= gfMultiply(coef, factor) })
  }
  return result
}

export interface QrCode {
  version: number
  size: number
  /** modules[y][x], true for dark. */
  modules: boolean[][]
}

/**
 * Encodes `text` (UTF-8) as a QR code in byte mode.
 *
 * Picks the smallest version that fits at `ecc`. `mask` forces a mask pattern
 * (0–7); left out, the lowest-penalty mask is chosen as the standard
 * describes.
 */
export function encodeQr(text: string, ecc: Ecc = 'M', options: { version?: number; mask?: number } = {}): QrCode {
  const bytes = [...new TextEncoder().encode(text)]

  let version = options.version ?? 0
  if (!version) {
    for (let v = 1; v <= 40; v++) {
      const countBits = v <= 9 ? 8 : 16
      if (4 + countBits + bytes.length * 8 <= dataCodewords(v, ecc) * 8) { version = v; break }
    }
    if (!version) throw new Error('text is too long for a QR code')
  }
  const countBits = version <= 9 ? 8 : 16
  const capacityBits = dataCodewords(version, ecc) * 8
  if (4 + countBits + bytes.length * 8 > capacityBits) throw new Error('text does not fit the requested version')

  // Bit stream: mode 0100 (byte), count, data, terminator, padding.
  const bits: number[] = []
  const append = (value: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1) }
  append(0b0100, 4)
  append(bytes.length, countBits)
  for (const b of bytes) append(b, 8)
  append(0, Math.min(4, capacityBits - bits.length))
  append(0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) append(pad, 8)
  const data: number[] = []
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2))

  // Error correction, split into blocks and interleaved.
  const e = ECC_INDEX[ecc]
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[e]![version]!
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[e]![version]!
  const rawCodewords = Math.floor(rawDataModules(version) / 8)
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks)
  const shortBlockLen = Math.floor(rawCodewords / numBlocks)
  const divisor = rsDivisor(blockEccLen)
  const blocks: number[][] = []
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1))
    k += dat.length
    const eccBytes = rsRemainder(dat, divisor)
    if (i < numShortBlocks) dat.push(0)
    blocks.push(dat.concat(eccBytes))
  }
  const codewords: number[] = []
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) codewords.push(block[i]!)
    })
  }

  // Function patterns.
  const size = version * 4 + 17
  const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const isFunction: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const setFunction = (x: number, y: number, dark: boolean) => { modules[y]![x] = dark; isFunction[y]![x] = true }

  for (let i = 0; i < size; i++) { setFunction(6, i, i % 2 === 0); setFunction(i, 6, i % 2 === 0) }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy))
        const x = cx + dx
        const y = cy + dy
        if (x >= 0 && x < size && y >= 0 && y < size) setFunction(x, y, d !== 2 && d !== 4)
      }
    }
  }
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4)

  const alignPositions: number[] = []
  if (version > 1) {
    const numAlign = Math.floor(version / 7) + 2
    const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2
    alignPositions.push(6)
    for (let pos = size - 7; alignPositions.length < numAlign; pos -= step) alignPositions.splice(1, 0, pos)
  }
  const last = alignPositions.length - 1
  alignPositions.forEach((ax, i) => alignPositions.forEach((ay, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFunction(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
  }))

  const drawFormat = (mask: number) => {
    const dataBits = (FORMAT_BITS[ecc] << 3) | mask
    let rem = dataBits
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const b = ((dataBits << 10) | rem) ^ 0x5412
    for (let i = 0; i <= 5; i++) setFunction(8, i, bit(b, i))
    setFunction(8, 7, bit(b, 6))
    setFunction(8, 8, bit(b, 7))
    setFunction(7, 8, bit(b, 8))
    for (let i = 9; i < 15; i++) setFunction(14 - i, 8, bit(b, i))
    for (let i = 0; i < 8; i++) setFunction(size - 1 - i, 8, bit(b, i))
    for (let i = 8; i < 15; i++) setFunction(8, size - 15 + i, bit(b, i))
    setFunction(8, size - 8, true)
  }
  drawFormat(0)

  if (version >= 7) {
    let rem = version
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const b = (version << 12) | rem
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3)
      const c = Math.floor(i / 3)
      setFunction(a, c, bit(b, i))
      setFunction(c, a, bit(b, i))
    }
  }

  // Data, in the zig-zag order.
  let i = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vert : vert
        if (!isFunction[y]![x] && i < codewords.length * 8) {
          modules[y]![x] = bit(codewords[i >>> 3]!, 7 - (i & 7))
          i++
        }
      }
    }
  }

  const applyMask = (mask: number) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let invert: boolean
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break
          case 1: invert = y % 2 === 0; break
          case 2: invert = x % 3 === 0; break
          case 3: invert = (x + y) % 3 === 0; break
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
        }
        if (invert && !isFunction[y]![x]) modules[y]![x] = !modules[y]![x]
      }
    }
  }

  let mask = options.mask ?? -1
  if (mask < 0) {
    let best = Infinity
    for (let m = 0; m < 8; m++) {
      applyMask(m)
      drawFormat(m)
      const p = penalty(modules)
      if (p < best) { best = p; mask = m }
      applyMask(m)
    }
  }
  applyMask(mask)
  drawFormat(mask)
  return { version, size, modules }
}

/** The standard's four penalty rules, used to choose a mask. */
function penalty(m: boolean[][]): number {
  const size = m.length
  let result = 0
  const lineScore = (get: (a: number, b: number) => boolean) => {
    for (let a = 0; a < size; a++) {
      let run = 1
      for (let b = 1; b <= size; b++) {
        if (b < size && get(a, b) === get(a, b - 1)) { run++; continue }
        if (run >= 5) result += 3 + (run - 5)
        run = 1
      }
      // Finder-like 1:1:3:1:1 with four light modules on one side.
      for (let b = 0; b + 10 < size; b++) {
        const seq = Array.from({ length: 11 }, (_, k) => get(a, b + k))
        const p1 = [true, false, true, true, true, false, true, false, false, false, false]
        const p2 = [false, false, false, false, true, false, true, true, true, false, true]
        if (seq.every((v, k) => v === p1[k]) || seq.every((v, k) => v === p2[k])) result += 40
      }
    }
  }
  lineScore((y, x) => m[y]![x]!)
  lineScore((x, y) => m[y]![x]!)
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = m[y]![x]
      if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) result += 3
    }
  }
  const dark = m.reduce((n, row) => n + row.filter(Boolean).length, 0)
  const total = size * size
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1
  result += k * 10
  return result
}

/** An SVG path covering every dark module, one unit per module, for drawing
 *  with a viewBox of `0 0 size size` plus any quiet zone. */
export function qrPath(code: QrCode, quiet = 4): string {
  const parts: string[] = []
  code.modules.forEach((row, y) => row.forEach((dark, x) => { if (dark) parts.push(`M${x + quiet} ${y + quiet}h1v1h-1z`) }))
  return parts.join('')
}
