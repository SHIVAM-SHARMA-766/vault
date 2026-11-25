// Unlock with a passkey (decisions/0022 (b), 0034).
//
//   Passkey (WebAuthn credential with the PRF extension)
//         | PRF(PASSKEY_PRF_SALT), computed inside the authenticator,
//         | after user verification (biometric or PIN)
//         v
//    PRF output (32 bytes, stable per credential, never leaves this browser)
//         | HKDF "vault.passkey.kek.v1"
//         v
//    Passkey KEK --- wraps the Vault Key, and seals the account's email
//
// The Vault Key is the same one the master password wraps (keys.ts), so this
// is one more wrapping beside the master and recovery ones: removing it
// deletes the wrapped copy and re-encrypts nothing. Both blobs are bound to
// the credential's id as additional data, so the server cannot hand one
// credential's blob to another.
//
// The email is sealed because the server keeps only a keyed digest of it, and
// a passkey sign-in starts without anyone typing it.

import { utf8Decode, utf8Encode } from './encoding.js'
import { hkdfSha256 } from './primitives.js'
import { seal, unseal } from './aead.js'
import { KEY_BYTES } from './keys.js'

/** The PRF input every Vault passkey is asked for. It is not a secret: the
 *  authenticator mixes it with a per-credential secret that never leaves it,
 *  so one constant gives each credential its own output. Versioned, and never
 *  edited in place, for the same reason as the HKDF labels. */
export const PASSKEY_PRF_SALT: Uint8Array = utf8Encode('vault.passkey-unlock.prf.v1')

const INFO_PASSKEY_KEK = 'vault.passkey.kek.v1'
const AAD_WRAP_PASSKEY = 'vault.wrap.passkey.v1'
const AAD_EMAIL_PASSKEY = 'vault.email.passkey.v1'

const aad = (label: string, credentialId: string) => utf8Encode(`${label}|${credentialId}`)

export async function derivePasskeyKek(prfOutput: Uint8Array): Promise<Uint8Array> {
  if (prfOutput.length < KEY_BYTES) throw new Error('A passkey PRF output must be at least 32 bytes.')
  return hkdfSha256(prfOutput, new Uint8Array(0), utf8Encode(INFO_PASSKEY_KEK), KEY_BYTES)
}

export interface PasskeyWrapping {
  wrappedVaultKey: string
  sealedEmail: string
}

export async function wrapForPasskey(vaultKey: Uint8Array, email: string, prfOutput: Uint8Array, credentialId: string): Promise<PasskeyWrapping> {
  const kek = await derivePasskeyKek(prfOutput)
  try {
    return {
      wrappedVaultKey: await seal(kek, vaultKey, aad(AAD_WRAP_PASSKEY, credentialId)),
      sealedEmail: await seal(kek, utf8Encode(email), aad(AAD_EMAIL_PASSKEY, credentialId)),
    }
  } finally { kek.fill(0) }
}

export async function unwrapWithPasskey(wrapping: PasskeyWrapping, prfOutput: Uint8Array, credentialId: string): Promise<{ vaultKey: Uint8Array; email: string }> {
  const kek = await derivePasskeyKek(prfOutput)
  try {
    const vaultKey = await unseal(kek, wrapping.wrappedVaultKey, aad(AAD_WRAP_PASSKEY, credentialId))
    const email = utf8Decode(await unseal(kek, wrapping.sealedEmail, aad(AAD_EMAIL_PASSKEY, credentialId)))
    return { vaultKey, email }
  } finally { kek.fill(0) }
}
