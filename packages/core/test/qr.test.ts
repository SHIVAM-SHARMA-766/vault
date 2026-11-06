// The QR encoder, checked module for module against an independent
// implementation (Python's `qrcode`), across versions 1–13, all four error
// correction levels, and several masks. The vectors were produced by that
// library, not by this one, so agreement means both follow the standard.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { encodeQr, qrPath } from '../src/index.js'

interface Vector { text: string; ecc: 'L' | 'M' | 'Q' | 'H'; mask: number; version: number; rows: string[] }
const { vectors } = JSON.parse(readFileSync(new URL('../../vectors/qr.json', import.meta.url), 'utf8')) as { vectors: Vector[] }

test('there are vectors spanning small and large versions', () => {
  const versions = new Set(vectors.map((v) => v.version))
  assert.ok(versions.has(1) && [...versions].some((v) => v >= 10), [...versions].join(','))
})

for (const v of vectors) {
  test(`matches the reference: v${v.version} ${v.ecc} mask ${v.mask} "${v.text.slice(0, 24)}…"`, () => {
    const code = encodeQr(v.text, v.ecc, { mask: v.mask })
    assert.equal(code.version, v.version, 'same smallest version')
    const rows = code.modules.map((r) => r.map((d) => (d ? '1' : '0')).join(''))
    assert.equal(rows.length, v.rows.length)
    rows.forEach((row, y) => assert.equal(row, v.rows[y], `row ${y}`))
  })
}

test('automatic mask selection produces a valid code of the same version', () => {
  const v = vectors.find((x) => x.ecc === 'M' && x.version >= 8)!
  const auto = encodeQr(v.text, 'M')
  assert.equal(auto.version, v.version)
  // Whatever mask it chose, it must be one of the eight, so it equals one of
  // the forced-mask encodings.
  const encodings = [0, 1, 2, 3, 4, 5, 6, 7].map((m) => JSON.stringify(encodeQr(v.text, 'M', { mask: m }).modules))
  assert.ok(encodings.includes(JSON.stringify(auto.modules)))
})

test('the SVG path has one square per dark module, offset by the quiet zone', () => {
  const code = encodeQr('x', 'M', { mask: 0 })
  const dark = code.modules.flat().filter(Boolean).length
  const path = qrPath(code, 4)
  assert.equal(path.match(/M/g)?.length, dark)
  assert.ok(!path.includes('M0 ') && !path.includes('M3 '), 'nothing inside the quiet zone')
})

test('text too long for any version is refused', () => {
  assert.throws(() => encodeQr('x'.repeat(4000), 'H'))
})
