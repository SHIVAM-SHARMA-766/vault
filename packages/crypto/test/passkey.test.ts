// Unlock with a passkey (decisions/0034): the PRF output wraps the vault key
// and the email, bound to the credential.

import test from 'node:test'
import assert from 'node:assert/strict'

import { PASSKEY_PRF_SALT, UnsealError, derivePasskeyKek, generateVaultKey, toHex, unwrapWithPasskey, utf8Decode, wrapForPasskey } from '../src/index.js'

test('the passkey kek is a fixed HKDF branch of the PRF output', async () => {
  // Known answer: HKDF-SHA256(ikm = 0x07 × 32, empty salt, "vault.passkey.kek.v1"),
  // checked against Node's hkdfSync. A change here locks out every enrolled passkey.
  assert.equal(toHex(await derivePasskeyKek(new Uint8Array(32).fill(7))), '41cea778a56fb2fc8efa93b2f89d297cf3ad3f186abddd12f590ddf4cb819a96')
  assert.equal(utf8Decode(PASSKEY_PRF_SALT), 'vault.passkey-unlock.prf.v1')
  await assert.rejects(derivePasskeyKek(new Uint8Array(16)), /32 bytes/)
})

test('the same PRF output and credential open the vault key and the email', async () => {
  const vaultKey = generateVaultKey()
  const prf = new Uint8Array(32).fill(9)
  const w = await wrapForPasskey(vaultKey, 'priya@example.test', prf, 'cred-1')
  const out = await unwrapWithPasskey(w, prf, 'cred-1')
  assert.equal(toHex(out.vaultKey), toHex(vaultKey))
  assert.equal(out.email, 'priya@example.test')
  assert.ok(prf.some((b) => b !== 0), 'the caller\'s PRF output is left alone')
})

test('another passkey, or a blob moved to another credential, does not open', async () => {
  const vaultKey = generateVaultKey()
  const prf = new Uint8Array(32).fill(9)
  const w = await wrapForPasskey(vaultKey, 'a@example.test', prf, 'cred-1')
  await assert.rejects(unwrapWithPasskey(w, new Uint8Array(32).fill(8), 'cred-1'), UnsealError)
  await assert.rejects(unwrapWithPasskey(w, prf, 'cred-2'), UnsealError)
  const other = await wrapForPasskey(vaultKey, 'b@example.test', prf, 'cred-1')
  await assert.rejects(unwrapWithPasskey({ wrappedVaultKey: w.wrappedVaultKey, sealedEmail: other.wrappedVaultKey }, prf, 'cred-1'), UnsealError,
    'a vault-key blob does not pass for an email blob')
})
