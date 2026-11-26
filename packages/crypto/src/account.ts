// The account password (decisions/0036): the first step of signing in, before
// the master password. It proves who someone is; it never opens the vault.
//
//   account password + its own salt
//         | Argon2id (19 MiB, t=2: lighter than the master password's, since
//         |           it unlocks nothing on its own)
//         v
//   HKDF "vault.account.v1"  -->  account proof, sent to the server, which
//                                 keeps only a slow hash of it
//
// The server never sees the account password itself. Its own salt and HKDF
// label keep the proof unrelated to the master password's keys even when a
// person reuses the same text (the apps refuse that, too).

import { argon2id, type Argon2Params } from './argon2.js'
import { toBase64Url, utf8Encode } from './encoding.js'
import { hkdfSha256 } from './primitives.js'
import { randomBytes } from './random.js'

export const ACCOUNT_KDF: Argon2Params = { m: 19_456, t: 2, p: 1 }

export interface AccountParams extends Argon2Params {
  /** base64url, 16 random bytes, per account. */
  salt: string
}

export function newAccountParams(): AccountParams {
  return { ...ACCOUNT_KDF, salt: toBase64Url(randomBytes(16)) }
}

/** base64url, 32 bytes: what the server checks for the account password. */
export async function deriveAccountProof(password: string, params: AccountParams): Promise<string> {
  const pw = utf8Encode(password.normalize('NFKC'))
  const salt = Uint8Array.from(atob(params.salt.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(params.salt.length / 4) * 4, '=')), (c) => c.charCodeAt(0))
  const stretched = await argon2id(pw, salt, { m: params.m, t: params.t, p: params.p }, 32)
  pw.fill(0)
  try {
    return toBase64Url(await hkdfSha256(stretched, new Uint8Array(0), utf8Encode('vault.account.v1'), 32))
  } finally { stretched.fill(0) }
}
