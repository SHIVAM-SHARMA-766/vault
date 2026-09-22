# 0001 — Cryptography and key hierarchy

Status: Accepted
Date: 2026-09-22

## Context

This is a zero-knowledge password manager. The server must be able to store and serve
the vault without being able to read it, and that property has to survive a full
compromise of the AWS account, the database, and the API code.

A previous implementation of this product claimed zero-knowledge but did not deliver it:
the master password was sent to the server in the request body and hashed there with
bcrypt. Anyone with code execution on the API — or a log line in the wrong place — would
have seen the master password in plaintext, and with it every entry. That failure mode is
the direct reason this document exists.

Three further requirements shape the design:

1. **Changing the master password must not require rewriting the vault.** The storage
   layer is DynamoDB, where an atomic multi-item write caps at 100 items. A design that
   re-encrypts every entry on a password change is one that breaks silently once the
   vault outgrows that cap.
2. **There is no password reset.** Zero-knowledge means the server cannot help. The only
   recovery path is a key issued to the user at signup.
3. **A second implementation is coming.** An Android client is planned. Two independent
   implementations of the same scheme will diverge unless they are pinned to shared,
   published test vectors from the start.

## Decision

### Primitives

| Purpose | Algorithm | Notes |
|---|---|---|
| Key derivation | PBKDF2-HMAC-SHA256, 600,000 iterations, 256-bit output | OWASP 2023 floor for SHA-256 |
| Sub-key derivation | HKDF-SHA256 | Domain-separated by `info` label |
| Encryption | AES-256-GCM, 96-bit random IV | Authenticated; IV never reused |
| Server-side hash | scrypt (N=2^15, r=8, p=1) | Node built-in, no native module |
| Randomness | `crypto.getRandomValues` / `crypto.randomBytes` | Never `Math.random` |

All primitives come from the platform: Web Crypto in the browser, `node:crypto` on the
server. No cryptographic primitive is implemented by hand, and the crypto package has no
third-party dependencies.

### Key hierarchy

```
Master Password  +  per-user random 32-byte salt
        │
        │  PBKDF2-SHA256, 600k iterations
        ▼
   Master Key (32 bytes, never leaves the device, never stored)
        │
        ├── HKDF(info="vault.kek.v1")  ──►  Key Encryption Key
        │                                        │
        │                                        │ AES-GCM wrap
        │                                        ▼
        │                                  wrappedVaultKey  ──► stored server-side
        │
        └── HKDF(info="vault.auth.v1") ──►  Auth Key  ──► sent to server on login
                                                 │
                                                 │ server applies scrypt
                                                 ▼
                                           stored auth verifier

   Vault Key (32 bytes, random, generated once at signup, never rotates)
        │
        ├── wrapped by Key Encryption Key      (master password path)
        └── wrapped by Recovery Key Encryption Key  (recovery path)
        │
        │  AES-256-GCM, fresh 96-bit IV per operation
        ▼
   Every entry field, including name, tags, and folder name
```

The Auth Key and the Key Encryption Key are separate HKDF branches of the same Master
Key. Learning the Auth Key — which the server necessarily sees on every login — reveals
nothing about the Key Encryption Key, because HKDF is not invertible and the labels are
domain-separated.

### Recovery key

At signup the client generates a second random 32-byte key, renders it as a Crockford
base32 string, and displays it exactly once. It is passed through HKDF
(`info="vault.recovery.v1"`) to produce a second Key Encryption Key, which wraps the same
Vault Key into a second stored blob.

Losing the master password is recoverable with the recovery key. Losing both is not, and
the server cannot help. This is a property of the design, not a defect.

### What is encrypted

Everything belonging to an entry — name, username, password, URL, notes, tags, entry
type, custom fields, TOTP secret — and folder names. The server stores ciphertext,
IVs, timestamps, and opaque identifiers.

Email addresses are stored as `HMAC-SHA256(server_pepper, normalized_email)`, so a table
dump does not reveal who the account belongs to. The pepper lives in SSM Parameter Store,
outside the table.

### Ciphertext format

Every encrypted blob is serialised as `v1.<base64url(iv)>.<base64url(ciphertext||tag)>`.
The version prefix is what allows the scheme to change later — a future `v2` can use a
different KDF or cipher, and both can coexist during migration.

### Salt lookup and user enumeration

The client needs the per-user salt before it can derive anything, so login begins with a
lookup by email. For an unknown email the server returns a deterministic decoy salt,
`HMAC-SHA256(server_pepper, "salt-decoy" || email)`, and the login then fails at the
verifier step exactly as a wrong password would. The endpoint therefore does not
distinguish registered from unregistered addresses.

## Rejected

**Argon2id as the KDF.** The better choice on paper, and OWASP's first recommendation.
Rejected for v1 because Web Crypto does not implement it, so the browser would need a
WebAssembly dependency inside the most security-critical code path in the product — the
one place where "no third-party dependencies" is worth the most. PBKDF2-SHA256 at 600k
meets the OWASP 2023 guidance for SHA-256. The ciphertext version prefix and the stored
per-user KDF parameters exist so this can be revisited without a breaking change.

**Sending the master password to the server.** What the previous implementation did. A
single compromised dependency, log statement, or memory dump on the API exposes every
vault. Non-negotiable.

**Per-entry keys wrapped individually.** The previous implementation's "v2" model. It
exists to support sharing an individual entry with another user. Sharing is out of scope,
and without it the model is pure cost: an extra wrap and unwrap per entry, two more
stored columns, and a second code path that is exercised rarely and therefore tested
least. A single Vault Key gives the same confidentiality for a single-user vault.

**Encrypting entries directly with the master-derived key.** Makes the master password
change an O(n) rewrite of the entire vault — the exact failure this design is built to
avoid. The Vault Key indirection turns it into a single write.

**Email as the KDF salt.** Removes the salt lookup round-trip, at the cost of letting an
attacker precompute against an address reused on other services.

**Hex encoding of ciphertext.** Doubles stored size and transfer for no benefit.
base64url costs nothing and is URL-safe.

**Plaintext entry names and tags.** Would allow server-side search and a more useful
admin view. It also tells anyone with database access which services the user holds
accounts for, which is most of the value of the vault. Single-user access patterns make
server-side search unnecessary: the client fetches the whole vault and filters locally.

## Consequences

**Changing the master password is a single write.** Re-derive the Master Key from the new
password, re-wrap the Vault Key, store the new salt and verifier. Entries are untouched,
and password history survives — unlike the previous implementation, which had to delete
it.

**The Vault Key never rotates.** If it ever must — suspected compromise of the key
itself — that is a full re-encrypt of the vault, performed client-side, and it is the one
operation that does not fit in a single transaction. Accepted: it is a rare, deliberate,
user-initiated action that can be resumed.

**Search, sort, and filter are entirely client-side.** The server cannot index what it
cannot read. This is workable because the vault is single-user and small; it would not
be at multi-tenant scale.

**The admin surface cannot show entry contents.** It can report counts, timestamps, and
storage size. Anything richer would require breaking the encryption boundary.

**AES-GCM IV collision bound.** Random 96-bit IVs under a single key reach a 2^-32
collision probability at roughly 2^32 encryptions. A personal vault performs on the order
of 2^20 encryptions in its lifetime, leaving a margin of about 2^-56. Documented rather
than mitigated; if the product ever becomes multi-tenant this needs revisiting.

**Two implementations must agree exactly.** Web now, Android later. Test vectors drawn
from published standards — RFC 6070 for PBKDF2, RFC 5869 for HKDF, the NIST CAVP GCM
vectors, RFC 6238 for TOTP — are checked into the repository and asserted by both
implementations in CI. They are written before the first client, not after the second.
