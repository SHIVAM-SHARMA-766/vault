// How an email address becomes a database key, and what an unknown address
// gets back.

import { createHmac } from 'node:crypto'

/** Case and surrounding whitespace must not produce different accounts. The
 *  client applies the same rule before deriving anything. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** The login pointer's partition key. The address itself is never stored, so a
 *  dump of the table says how many accounts exist and nothing about whose. The
 *  pepper lives in Parameter Store, so holding the table is not enough to test
 *  guesses against it. */
export function emailDigest(email: string, pepper: string): string {
  return createHmac('sha256', pepper).update(`email|${normalizeEmail(email)}`).digest('base64url')
}

/** A salt for an address that has no account.
 *
 *  The client must fetch a salt before it can derive anything, so the lookup
 *  cannot simply refuse unknown addresses — that would turn it into an oracle
 *  for which addresses are registered. This returns a value that is stable for
 *  a given address, uniformly distributed, and indistinguishable from a real
 *  salt. Login then fails at the verifier, exactly as a wrong password does.
 *
 *  See docs/threat-model.md, A7. */
export function decoySalt(email: string, pepper: string): string {
  return createHmac('sha256', pepper)
    .update(`salt-decoy|${normalizeEmail(email)}`)
    .digest('base64url')
}

/** Whether an unknown address's decoy claims a secret key (decisions/0027).
 *  Real accounts with one answer `version: 2`; if no decoy ever did, that
 *  answer alone would prove an account exists. About one decoy in eight says
 *  so too, chosen per address and stable, so asking twice tells nothing. */
export function decoyHasSecretKey(email: string, pepper: string): boolean {
  return createHmac('sha256', pepper).update(`secret-key-decoy|${normalizeEmail(email)}`).digest()[0]! < 32
}
