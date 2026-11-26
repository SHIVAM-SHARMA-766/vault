// Argon2id (decisions/0028): RFC 9106's vector, values from the reference
// implementation (argon2-cffi 25.1, libargon2) for the shapes Vault uses, the
// KdfParams plumbing, and the parameter limits.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import {
  ARGON2_DEFAULT, argon2id, blake2b, changePassword, costOf, createAccount, deriveMasterKey, fromBase64Url,
  kdfIsOutdated, kdfProblem, openEntry, sealEntry, toHex, unlock, utf8Encode,
} from '../src/index.js'
import { ARGON2_WASM_BASE64, ARGON2_WASM_SHA256 } from '../src/argon2-wasm.js'

const fill = (n: number, b: number) => new Uint8Array(n).fill(b)

test('BLAKE2b matches RFC 7693 and Node for 64-byte output', () => {
  assert.equal(toHex(blake2b(utf8Encode('abc'), 64)), 'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923')
  for (const len of [0, 1, 127, 128, 129, 256, 1000]) {
    const input = new Uint8Array(len).map((_, i) => i * 7)
    assert.equal(toHex(blake2b(input, 64)), createHash('blake2b512').update(input).digest('hex'), `length ${len}`)
  }
})

test('Argon2id matches the RFC 9106 test vector (5.3)', async () => {
  const tag = await argon2id(fill(32, 1), fill(16, 2), { m: 32, t: 3, p: 4 }, 32, { secret: fill(8, 3), ad: fill(12, 4) })
  assert.equal(toHex(tag), '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659')
})

test('Argon2id matches the reference implementation for the shapes Vault uses', async () => {
  // Vault's setting: 64 MiB, t = 3, p = 1, a 32-byte salt.
  assert.equal(toHex(await argon2id(utf8Encode('correct horse battery staple'), fill(32, 5), ARGON2_DEFAULT)),
    '5a487fda32defe8247bf66ac8774b8c4a81d3e80e53804f92b0438fcdfa3c467')
  // The lower limit, two lanes, an empty password, a 64-byte tag.
  assert.equal(toHex(await argon2id(new Uint8Array(0), fill(8, 9), { m: 19_456, t: 1, p: 2 }, 64)),
    'd094cd21681312edb219d87fdf5970c3f030093ce1f5e346f9137374e4cf36851586236c1c097ed820e53de3872a52c8483d906cd9831cd3e328e62cbae60fa7')
  // Memory that is not a multiple of 4p, three lanes, and a tag longer than 64 bytes.
  assert.equal(toHex(await argon2id(utf8Encode('pässwörd'), utf8Encode('saltsaltsaltsalt'), { m: 100, t: 2, p: 3 }, 100)),
    'db7b28cc73505223c9daeba4cf8bde716324679faada9d850e25587ff5977d080e4778183091f9492afb440fb864ec905e72ea64e9a28f6f9dee2faa9e0dccba3f024b1c04318f277f7db1d8eb691b49a7a2365f025c848b6abea0c6cab1cf0244f68d67')
})

test('the embedded module is the one its checksum names', () => {
  assert.equal(createHash('sha256').update(Buffer.from(ARGON2_WASM_BASE64, 'base64')).digest('hex'), ARGON2_WASM_SHA256)
  assert.ok(readFileSync(new URL('../../argon2/argon2.wat', import.meta.url), 'utf8').includes('(export "fill")'))
})

test('Argon2id refuses parameters it cannot honour', async () => {
  await assert.rejects(argon2id(fill(4, 1), fill(4, 2), ARGON2_DEFAULT), /salt/)
  await assert.rejects(argon2id(fill(4, 1), fill(16, 2), { m: 8, t: 1, p: 2 }), /memory/)
  await assert.rejects(argon2id(fill(4, 1), fill(16, 2), { m: 64, t: 0, p: 1 }), /pass/)
})

test('the master key uses the stored algorithm, and an upgrade keeps every item', async () => {
  const salt = fill(32, 5)
  const viaKdf = await deriveMasterKey('correct horse battery staple', salt, ARGON2_DEFAULT)
  assert.equal(toHex(viaKdf), '5a487fda32defe8247bf66ac8774b8c4a81d3e80e53804f92b0438fcdfa3c467', 'no secret key: the Argon2id output is the master key')

  // An account from before 0028, with an item in it.
  const old = await createAccount('first-master-password', 100_000)
  assert.equal(old.kdf.algorithm, 'PBKDF2-HMAC-SHA256')
  assert.equal(kdfIsOutdated(old.kdf), true)
  const blob = await sealEntry('entry-1', { type: 'login', name: 'Bank', password: 'hunter2' } as never, old.vaultKey)
  // Upgrade: same password, Argon2id, the same vault key re-wrapped.
  const upgraded = await changePassword('first-master-password', old.vaultKey)
  assert.equal(upgraded.kdf.algorithm, 'argon2id')
  assert.equal(kdfIsOutdated(upgraded.kdf), false)
  const opened = await unlock('first-master-password', upgraded.kdf, upgraded.wrappedVaultKey, fromBase64Url(upgraded.kdf.salt))
  assert.equal((await openEntry('entry-1', blob, opened.vaultKey) as { name: string }).name, 'Bank')
  assert.equal(opened.authKey, upgraded.authKey)
  assert.deepEqual(costOf(upgraded.kdf), ARGON2_DEFAULT)
  assert.equal(costOf(old.kdf), 100_000)
})

test('key derivation settings outside the limits are refused', () => {
  const salt = 'AAAA'
  assert.equal(kdfProblem({ algorithm: 'argon2id', m: 65_536, t: 3, p: 1, salt }), null)
  assert.equal(kdfProblem({ algorithm: 'PBKDF2-HMAC-SHA256', iterations: 600_000, salt }), null)
  for (const bad of [
    { algorithm: 'argon2id', m: 1024, t: 3, p: 1, salt },
    { algorithm: 'argon2id', m: 4_194_304, t: 3, p: 1, salt },
    { algorithm: 'argon2id', m: 65_536, t: 100, p: 1, salt },
    { algorithm: 'argon2id', m: 65_536, t: 3, p: 16, salt },
    { algorithm: 'argon2id', m: 65_536.5, t: 3, p: 1, salt },
    { algorithm: 'PBKDF2-HMAC-SHA256', iterations: 1000, salt },
    { algorithm: 'scrypt', salt },
    { algorithm: 'argon2id', m: 65_536, t: 3, p: 1 },
    null,
  ]) assert.notEqual(kdfProblem(bad), null, JSON.stringify(bad))
})
