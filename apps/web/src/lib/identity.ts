// The account's identity key pair, as the client makes it (decisions/0009).
//
// Generated in the browser; the private half is sealed under the vault key
// before it leaves, and the plaintext is wiped. The server stores the public
// key for others to share with, and a private key it cannot open.

import { generateIdentityKeyPair, toBase64Url, wipe, wrapIdentityPrivateKey } from '@vault/crypto'

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
