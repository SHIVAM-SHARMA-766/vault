# 0023: The open crypto questions: signed key grants, a secret key, Argon2id, organization recovery

Status: **Proposed** (the remaining item of phase 3.5's "decide the crypto questions")
Date: 2026-11-08
Backlog: D10; threat A15

## 1. Signed key grants (threat A15)

Today an admin's app seals a collection key to a member's public key, and the server delivers
it. A hostile server could seal a key of its own choosing to a member, and the member's app
would accept it.

- **Proposal:** each grant carries a signature by the granting admin's identity key, over
  `(org, collection, version, recipient public key, sealed key hash)`. Each organization
  member's app keeps the set of admin public keys it has confirmed, the way members are
  confirmed today, and refuses grants not signed by one of them.
- **Cost:** a new key type (Ed25519 or ECDSA P-256 via WebCrypto), a migration that re-signs
  existing grants the next time an admin opens each collection, and a rule for when an admin
  leaves.
- **Recommendation:** do it. It closes the one design gap the security review recorded.

## 2. A secret key in the key derivation (1Password's "Secret Key")

A random 128-bit key, generated on the device and never sent, is mixed into the KDF with the
master password. A stolen database becomes useless for offline guessing, even against a weak
password.

- **Cost:** every new device needs the secret key, by QR code or typed in, and losing every copy
  plus the master password loses the vault (the recovery key already covers this). It is a
  sign-in change for every person.
- **Recommendation:** offer it as **opt-in per account** first ("Add a secret key"), with an
  Emergency Kit to print. Making it the default is a later, separate decision.

## 3. Argon2id instead of PBKDF2

PBKDF2-SHA256 at 600,000 rounds is what WebCrypto provides natively. Argon2id resists GPU
cracking far better, but needs WebAssembly in the browser.

- **Cost:** a WASM module, which must be vendored and reproducibly built because there are no
  CDNs. The KDF parameters are already stored per account, so accounts can migrate the next
  time they change their password.
- **Recommendation:** yes, after the secret key decision. If the secret key ships, it removes
  most of the offline-guessing risk Argon2id addresses.

## 4. Organization recovery

If every owner and admin of an organization loses access, its collections are unreadable. That
is by design today, as decision 0016 left it open.

- **Options:** (a) keep it so and say so; (b) an *organization recovery key* printed at creation,
  as the personal recovery key is; (c) escrow to the server operator, which is rejected because
  it breaks zero knowledge.
- **Recommendation:** (b), offered and strongly suggested at creation, never escrowed.

## What is needed

A yes or no on each of the four. Each accepted item becomes its own decision record with test
vectors before code, as 0001 did.
