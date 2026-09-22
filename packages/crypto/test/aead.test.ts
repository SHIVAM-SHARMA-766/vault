// The sealed-blob format, and the tamper resistance the rest of the design
// assumes it provides.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SEALED_VERSION,
  UnsealError,
  randomBytes,
  seal,
  sealJson,
  sealString,
  toBase64Url,
  unseal,
  unsealJson,
  unsealString,
  utf8Encode,
} from '../src/index.js'

const key = () => new Uint8Array(32).fill(0x2a)

test('a sealed blob has the documented three-part shape', async () => {
  const blob = await sealString(key(), 'hello')
  const parts = blob.split('.')
  assert.equal(parts.length, 3)
  assert.equal(parts[0], SEALED_VERSION)
  assert.match(blob, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'base64url, no padding')
})

test('round-trips strings, bytes, and JSON', async () => {
  const k = key()
  assert.equal(await unsealString(k, await sealString(k, 'hello world')), 'hello world')

  const bytes = randomBytes(64)
  assert.deepEqual(await unseal(k, await seal(k, bytes)), bytes)

  const value = { a: 1, b: ['two', null], c: { d: true } }
  assert.deepEqual(await unsealJson(k, await sealJson(k, value)), value)
})

test('round-trips text that would break a naive encoding', async () => {
  const k = key()
  for (const text of ['', 'नमस्ते', '🔐🗝️', 'a\u0000b', '"quotes" and \\backslashes\\']) {
    assert.equal(await unsealString(k, await sealString(k, text)), text)
  }
})

test('the same plaintext seals to a different blob each time', async () => {
  const k = key()
  const a = await sealString(k, 'same')
  const b = await sealString(k, 'same')
  assert.notEqual(a, b, 'a fresh IV per operation')
})

test('the wrong key fails to unseal', async () => {
  const blob = await sealString(key(), 'secret')
  await assert.rejects(() => unsealString(new Uint8Array(32).fill(0x2b), blob), UnsealError)
})

test('a modified ciphertext fails to unseal', async () => {
  const k = key()
  const blob = await sealString(k, 'secret')
  const [v, iv, body] = blob.split('.') as [string, string, string]
  // Flip one bit of the body and re-encode.
  const bytes = Uint8Array.from(atob(body.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
  bytes[0] = bytes[0]! ^ 0x01
  await assert.rejects(() => unsealString(k, `${v}.${iv}.${toBase64Url(bytes)}`), UnsealError)
})

test('a modified IV fails to unseal', async () => {
  const k = key()
  const blob = await sealString(k, 'secret')
  const [v, , body] = blob.split('.') as [string, string, string]
  await assert.rejects(() => unsealString(k, `${v}.${toBase64Url(randomBytes(12))}.${body}`), UnsealError)
})

test('malformed input is rejected rather than misread', async () => {
  const k = key()
  for (const bad of ['', 'not-a-blob', 'v1.only-two', 'v1.a.b.c', 'v1..', 'v9.AAAA.AAAA']) {
    await assert.rejects(() => unsealString(k, bad), UnsealError, `rejected: ${bad}`)
  }
})

test('an IV of the wrong length is rejected', async () => {
  const k = key()
  const blob = await sealString(k, 'secret')
  const [v, , body] = blob.split('.') as [string, string, string]
  await assert.rejects(() => unsealString(k, `${v}.${toBase64Url(randomBytes(16))}.${body}`), UnsealError)
})

test('additional authenticated data binds a blob to its context', async () => {
  const k = key()
  const blob = await sealString(k, 'secret', utf8Encode('context:a'))
  assert.equal(await unsealString(k, blob, utf8Encode('context:a')), 'secret')
  await assert.rejects(() => unsealString(k, blob, utf8Encode('context:b')), UnsealError)
  await assert.rejects(() => unsealString(k, blob), UnsealError, 'omitting the context also fails')
})

test('a failure to unseal never reveals why', async () => {
  // Distinguishing "malformed" from "authentication failed" is occasionally
  // useful to an attacker and never useful to a user.
  const k = key()
  const messages = new Set<string>()
  for (const bad of ['garbage', 'v1.AAAA.AAAA', await sealString(new Uint8Array(32).fill(1), 'x')]) {
    await unsealString(k, bad).catch((e: unknown) => messages.add((e as Error).message))
  }
  assert.equal(messages.size, 1, `one message for every failure, saw: ${[...messages].join(' | ')}`)
})

test('an unsupported version is named, so a future format can be diagnosed', async () => {
  await assert.rejects(
    () => unsealString(key(), 'v2.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAA'),
    /unsupported ciphertext version: v2/,
  )
})

test('invalid JSON inside a valid blob is rejected', async () => {
  const k = key()
  const blob = await sealString(k, 'not json at all')
  await assert.rejects(() => unsealJson(k, blob), UnsealError)
})

test('a blob containing invalid base64url is rejected', async () => {
  // Distinct from a wrong-length IV: the decoder itself refuses these, and the
  // failure has to surface as the same UnsealError as everything else.
  const k = key()
  for (const bad of ['v1.@@@@.AAAA', 'v1.AAAAAAAAAAAAAAAA.!!!!', 'v1.****.****']) {
    await assert.rejects(() => unsealString(k, bad), UnsealError, `rejected: ${bad}`)
  }
})

test('plaintext that is not valid UTF-8 fails as a decryption error', async () => {
  // seal() accepts arbitrary bytes, so a blob can authenticate correctly and
  // still not be text. unsealString must report that the same way as any other
  // failure rather than leaking a TextDecoder error.
  const k = key()
  const blob = await seal(k, new Uint8Array([0xff, 0xfe, 0xfd]))
  await assert.rejects(() => unsealString(k, blob), UnsealError)
  assert.deepEqual(await unseal(k, blob), new Uint8Array([0xff, 0xfe, 0xfd]))
})
