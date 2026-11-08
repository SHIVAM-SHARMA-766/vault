// The account's identity key pair, as the client makes it (decisions/0009).
//
// Generated in the browser; the private half is sealed under the vault key
// before it leaves, and the plaintext is wiped. The server stores the public
// key for others to share with, and a private key it cannot open.

import { generateIdentityKeyPair, generateSigningKeyPair, toBase64Url, wipe, wrapIdentityPrivateKey, wrapSigningPrivateKey } from '@vault/crypto'

import type { Identity } from './api.js'

export async function newIdentity(vaultKey: Uint8Array): Promise<Identity> {
  const pair = await generateIdentityKeyPair()
  try {
    return {
      publicKey: toBase64Url(pair.publicKey),
      wrappedPrivateKey: await wrapIdentityPrivateKey(pair.privateKey, vaultKey),
    }
  } finally {
    wipe(pair.privateKey)
  }
}

/** The account's signing key pair (decisions/0025), made the same way. */
export async function newSigningKey(vaultKey: Uint8Array): Promise<{ signingPublicKey: string; wrappedSigningKey: string }> {
  const pair = await generateSigningKeyPair()
  try {
    return { signingPublicKey: toBase64Url(pair.publicKey), wrappedSigningKey: await wrapSigningPrivateKey(pair.privateKey, vaultKey) }
  } finally {
    wipe(pair.privateKey)
  }
}
