// Passkey byte formats (decisions/0035): CBOR, authenticator data, DER
// signatures, and which rpIds a page may use.

import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign, verify } from 'node:crypto'

import { PASSKEY_FLAGS, attestationObject, authenticatorData, cbor, coseEs256, p1363ToDer, rpIdAllowed } from '../src/index.js'

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

test('CBOR encodes what WebAuthn needs, as RFC 8949 says', () => {
  assert.equal(hex(cbor(0)), '00')
  assert.equal(hex(cbor(23)), '17')
  assert.equal(hex(cbor(24)), '1818')
  assert.equal(hex(cbor(-1)), '20')
  assert.equal(hex(cbor(-7)), '26')
  assert.equal(hex(cbor(1000)), '1903e8')
  assert.equal(hex(cbor('none')), '646e6f6e65')
  assert.equal(hex(cbor(new Uint8Array([1, 2]))), '420102')
  assert.equal(hex(cbor(new Map())), 'a0')
  assert.equal(hex(cbor({ a: 1 })), 'a1616101')
})

test('authenticator data: flags, zero count, and the attested credential', () => {
  const rp = new Uint8Array(32).fill(9)
  const get = authenticatorData(rp)
  assert.equal(get.length, 37)
  assert.equal(get[32], PASSKEY_FLAGS.UP | PASSKEY_FLAGS.UV | PASSKEY_FLAGS.BE | PASSKEY_FLAGS.BS)
  assert.deepEqual([...get.subarray(33)], [0, 0, 0, 0])
  const cose = coseEs256(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2))
  const id = new Uint8Array(16).fill(7)
  const reg = authenticatorData(rp, { credentialId: id, cosePublicKey: cose })
  assert.equal(reg[32]! & PASSKEY_FLAGS.AT, PASSKEY_FLAGS.AT)
  assert.equal(reg.length, 37 + 16 + 2 + 16 + cose.length)
  assert.deepEqual([...reg.subarray(53, 55)], [0, 16])
  assert.ok(hex(attestationObject(get)).startsWith('a363666d74646e6f6e65'), 'fmt: none first')
})

test('DER signatures verify where the raw form was signed, including high bits and leading zeros', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  for (let i = 0; i < 64; i++) {
    const data = Buffer.from(`message ${i}`)
    const raw = sign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' })
    const der = p1363ToDer(new Uint8Array(raw))
    assert.ok(verify('sha256', data, publicKey, Buffer.from(der)), `signature ${i}`)
  }
  assert.throws(() => p1363ToDer(new Uint8Array(63)))
})

test('a page may use its own host or a parent domain as rpId, never a public suffix or another site', () => {
  assert.ok(rpIdAllowed('https://login.example.com', 'example.com'))
  assert.ok(rpIdAllowed('https://login.example.com', 'login.example.com'))
  assert.ok(rpIdAllowed('https://example.co.uk', 'example.co.uk'))
  assert.ok(rpIdAllowed('http://localhost:3000', 'localhost'))
  assert.equal(rpIdAllowed('https://example.com', 'login.example.com'), false, 'not a child')
  assert.equal(rpIdAllowed('https://example.com.evil.io', 'example.com'), false)
  assert.equal(rpIdAllowed('https://evil-example.com', 'example.com'), false)
  assert.equal(rpIdAllowed('https://foo.github.io', 'github.io'), false, 'a public suffix')
  assert.equal(rpIdAllowed('https://example.co.uk', 'co.uk'), false)
  assert.equal(rpIdAllowed('http://example.com', 'example.com'), false, 'not over http')
  assert.equal(rpIdAllowed('http://127.0.0.1:8080', '127.0.0.1'), false)
  assert.equal(rpIdAllowed('not a url', 'example.com'), false)
})
