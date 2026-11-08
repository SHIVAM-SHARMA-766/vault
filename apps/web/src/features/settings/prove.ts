// Proving the current master password to the server without sending it.

import { wipe } from '@vault/crypto'

import { deriveForAccount } from '../../lib/secretkey.js'

import type * as session from '../../lib/session.js'

/** The auth key for a password, derived with the account's current KDF
 *  parameters. The server checks it against its verifier. */
export async function proveCurrent(state: session.Unlocked, password: string): Promise<string> {
  const keys = await deriveForAccount(state, password)
  wipe(keys.kek)
  return keys.authKey
}
