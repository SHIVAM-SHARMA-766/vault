# 0025: Signed key grants (closes threat A15)

Status: Accepted; implemented 2026-11-08
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

## As built (2026-11-08)

- **Encoding:** a pipe-joined string, not canonical JSON:
  `vault.grant.v1|org|collection|version|recipientFingerprint|base64url(SHA-256(keyBlob))`. Every
  field is an id, a number, hex or base64url, so `|` cannot occur, and the code refuses it if it
  does. Known-answer vectors are pinned, and the pinned signature is cross-checked with Node's
  crypto (P1363 encoding).
- **Pinning the owner:** a member's app pins the owner's signing key the first time it sees it
  (trust on first use), in a trust store sealed with the member's vault key
  (`vault.trust.v1:<org>`). If the owner's key or identity later differs, keys signed under
  trust are refused, the organization shows *The owner's key changed*, and the member re-pins
  only after comparing fingerprints. An organization recovery (0026) causes this on purpose.
- **Migration rule, refined:**
  - A grant with no signature, **or signed by someone this account does not trust yet** (an
    admin the owner has still to re-confirm), is accepted as *unsigned* until the account has
    seen every grant it holds in the organization verify once.
  - After that, the trust store records `requireSigned` and such grants are refused.
  - A signature from a **trusted** signer that does not verify is always refused.
  - A forged signature by an untrusted key gains an attacker nothing over a missing one, so
    treating both alike loses no protection and keeps existing organizations working during
    the switch.
- **Upkeep:**
  - An owner's app endorses each confirmed admin, over their full fingerprint.
  - A manager's app re-seals and signs, from its own copy of the collection key, every grant
    still unsigned. It never signs a blob it did not make.
  - Members whose fingerprint changed because a signing key was added show **Re-confirm** to
    admins.
- **Tests:**
  - crypto: known answers; refusal of every changed field, of another key, and of junk
  - API: enrolment once, signature storage and preservation, the trust store, re-confirm, endorse
  - end to end: Playwright rewrites the server's answer, and a swapped key blob, then a stripped
    signature after full signing, both show *Key not trusted* and the key is not used
