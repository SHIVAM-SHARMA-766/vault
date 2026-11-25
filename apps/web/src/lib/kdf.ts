// The cost for keys made from now on (decisions/0028): Argon2id, unless this
// page cannot run WebAssembly, when it falls back to PBKDF2 rather than fail
// a sign-up or a password change. Settings then offers the upgrade again.

import { ARGON2_DEFAULT, type KdfCost, PBKDF2_ITERATIONS, argon2Supported } from '@vault/crypto'

export async function newKdfCost(): Promise<KdfCost> {
  return (await argon2Supported()) ? ARGON2_DEFAULT : PBKDF2_ITERATIONS
}
