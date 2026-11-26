// How an email address becomes a database key, and what an unknown address
// gets back.

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'

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
/** Which algorithm an unknown address's decoy claims (decisions/0028). New
 *  accounts use Argon2id and older ones PBKDF2 until they upgrade, so decoys
 *  say both, about half and half, stably per address. Otherwise the
 *  algorithm alone would say whether an account exists. */
export function decoyUsesArgon2(email: string, pepper: string): boolean {
  return createHmac('sha256', pepper).update(`kdf-decoy|${normalizeEmail(email)}`).digest()[0]! < 128
}

export function decoyHasSecretKey(email: string, pepper: string): boolean {
  return createHmac('sha256', pepper).update(`secret-key-decoy|${normalizeEmail(email)}`).digest()[0]! < 32
}

// ── The address itself (decisions/0037) ────────────────────────────────────
// The email address is the username, shown to the person and to staff, so it
// is kept: sealed with AES-256-GCM under a key from the pepper, which lives
// outside the database. A database dump alone does not yield addresses.


const emailKey = (pepper: string) => createHmac('sha256', pepper).update('vault.email-at-rest.v1').digest()

export function sealEmail(pepper: string, email: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', emailKey(pepper), iv)
  const body = Buffer.concat([c.update(email.trim().toLowerCase(), 'utf8'), c.final(), c.getAuthTag()])
  return `e1.${iv.toString('base64url')}.${body.toString('base64url')}`
}

export function openEmail(pepper: string, sealed: string): string {
  const [v, iv, body] = sealed.split('.')
  if (v !== 'e1' || !iv || !body) throw new Error('unreadable address')
  const raw = Buffer.from(body, 'base64url')
  const d = createDecipheriv('aes-256-gcm', emailKey(pepper), Buffer.from(iv, 'base64url'))
  d.setAuthTag(raw.subarray(raw.length - 16))
  return Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString('utf8')
}
