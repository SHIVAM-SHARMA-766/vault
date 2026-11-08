# 0025: Signed key grants (closes threat A15)

Status: Accepted (design); implementation follows, with test vectors before code
Date: 2026-11-08
Implements: [0023](0023-crypto-hardening.md) §1

## Problem

A collection key reaches a member as `sealCollectionKey(memberPublicKey, key, collectionId,
version)`. Anyone holding the member's public key can make one, and that includes the server,
which hands out public keys. A hostile server could seal **a key it chose** to a member. The
member's app would accept it, and the member would write new items under a key the server knows.

## Design

**Each account gets a second key pair, for signing.** ECDSA P-256 via WebCrypto, beside the
existing ECDH identity key (0009).

- It is not one key pair used for both purposes, because cross-protocol key reuse is avoided.
- The private half is sealed under the vault key (`vault.identity.signing.v1`), exactly like the
  ECDH private key.
- The public half is published next to the ECDH public key.

**The fingerprint covers both public keys:** `SHA-256(ecdhPublic || signingPublic)`, first 128
bits, as today's eight groups.

- Accounts enrolled before this have only an ECDH key. Their app enrols a signing key at the
  next unlock, as identity keys were enrolled. Their fingerprint changes once, and the app says
  so ("your fingerprint changed because a signing key was added").
- Organization admins see "re-confirm" on members whose fingerprint changed.
- Confirming a member already pins their full fingerprint, so the confirmation protects both
  keys from then on.

**A grant is signed by the admin who makes it:**

```
grant = { org, collection, version, recipientFingerprint, sealedKeyHash: SHA-256(sealed blob) }
signature = ECDSA-P256-SHA256(adminSigningKey, canonicalJSON("vault.grant.v1", grant))
```

The signature and the granting admin's user id are stored with the access row.

**Members verify before they use a key.**

- A member's app trusts the signing keys of the admins whose fingerprints it has seen confirmed:
  - the owner, whose fingerprint the member compares out of band once, when joining (the
    invitation page shows it);
  - any admin the owner has confirmed. The owner signs `vault.admin.v1 { org, adminFingerprint }`.
- A grant is refused if its signature does not verify against a trusted admin key, or if its
  `recipientFingerprint` is not the member's own.
- Group grants and rotations are grants like any other, signed the same way.

**Migration:** existing access rows have no signature. A member's app accepts an unsigned grant
only for keys it already holds (it keeps a hash of each collection key it has opened), and shows
"waiting for an admin to re-sign". An admin's app re-signs every grant it can open the next
time it opens the organization. After every row is signed, unsigned grants are refused.

## Test vectors (before code)

- canonical JSON of a fixed grant, in bytes
- ECDSA verification of a fixed signature over it, from a fixed key (known-answer test)
- refusal of: a tampered `version`, a swapped `recipientFingerprint`, a signature by an
  untrusted key, and an unsigned grant for a collection key the member has not opened before

## Consequences

- Organization joins gain one step: the member compares the owner's fingerprint, as admins
  compare members' today.
- A server can still withhold grants or delete rows (denial of service), but can no longer
  substitute keys.
