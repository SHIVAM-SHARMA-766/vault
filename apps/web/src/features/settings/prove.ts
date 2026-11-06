// Proving the current master password to the server without sending it.

import { deriveLoginKeys, fromBase64Url, wipe } from '@vault/crypto'

import type * as session from '../../lib/session.js'

/** The auth key for a password, derived with the account's current KDF
 *  parameters. The server checks it against its verifier. */
export async function proveCurrent(state: session.Unlocked, password: string): Promise<string> {
  const keys = await deriveLoginKeys(password, fromBase64Url(state.kdf.salt), state.kdf.iterations)
  wipe(keys.kek)
  return keys.authKey
}
