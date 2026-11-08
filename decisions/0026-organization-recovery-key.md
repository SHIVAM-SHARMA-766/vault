# 0026: Organization recovery key

Status: Accepted; implemented 2026-11-08
Date: 2026-11-08
Implements: [0023](0023-crypto-hardening.md) §4; settles the open question in 0016

## Problem

If every owner and admin of an organization loses access, nobody can re-grant anything. A
collection key is sealed to each member's own public key (0009), not to the organization key.
So escrowing the organization key alone would recover nothing inside the collections. Sealing
collection keys to the organization key is rejected, because every confirmed member holds the
organization key, and that would erase per-collection access.

## Design

**The recovery key is the secret half of a key pair.** When the owner creates the recovery key,
their app:

1. generates a 32-byte **recovery key** `R` and shows it once, grouped like a personal recovery key;
2. derives `kek = HKDF(R, info "vault.org-recovery.kek.v1:<org>")` and
   `auth = HKDF(R, info "vault.org-recovery.auth.v1:<org>")`, two independent branches;
3. generates an ECDH P-256 **recovery key pair** (the identity-key primitive, 0009);
4. stores on the server:
   - the recovery **public key**
   - `escrow = AES-256-GCM(kek, recoveryPrivateKey, aad "vault.org-recovery|<org>")`
   - `verifier = SHA-256(auth)`
   - `orgKeyRecovery = sealForRecipient(recoveryPublic, orgKey, "org-key-recovery:<org>")`

**Every collection key is also sealed to the recovery public key.**

- The blob is
  `collection.recoveryBlob = sealForRecipient(recoveryPublic, collectionKey, "collection-key-recovery:<collection>:<version>")`.
- It is written when a collection is created or rotated, and, when the recovery key is first
  created, for every collection the owner's app can open.
- Only someone holding `R` can open these, so per-collection access is unchanged. Collections
  the owner cannot open stay unescrowed until someone who manages them opens the organization;
  their app adds the blob. The panel shows how many collections are covered.

**Recovery (any member, confirmed or not):**

1. Enter `R`. The app derives `kek` and `auth`, fetches the escrow, and opens the recovery
   private key.
2. With it, the app opens the org key and every collection key that has a recovery blob.
3. It re-seals them to the member's own public key.
4. It sends `auth` with the re-sealed keys. The server checks `SHA-256(auth)` against the
   verifier (constant time, rate limited).
5. The server makes the member the owner (the previous owner becomes an admin), stores their org
   key and access rows (*manage*), audits it, and notifies every remaining owner and admin.

`auth` is a bearer secret, but it is separate from `kek`. The server, seeing `auth` at recovery,
still cannot open the escrow.

**Replacing the key** creates a new pair and new blobs, and drops the old ones.

## Tests

- crypto: the two HKDF branches differ; escrow round trip; a recovery blob opens only with the
  right private key and context
- API: setting the key needs the owner; recovery with the right `auth` promotes and writes
  access; refusal of a wrong `auth`, a non-member, and absurdly many attempts; audit and
  notifications
- e2e: create an organization with a recovery key, share an item, then another member recovers
  with the key and opens the item
