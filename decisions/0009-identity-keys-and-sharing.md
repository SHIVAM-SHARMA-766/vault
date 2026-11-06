# 0009 — Identity keys, and the shape sharing will take

Status: Accepted (identity keys implemented; sharing designed, not built)
Date: 2026-11-06

## Context

Vault is becoming a password manager for teams ([ROADMAP.md](../ROADMAP.md)). Everything in
it so far is symmetric: one random vault key per account, wrapped by keys only its owner can
derive ([0001](0001-cryptography-and-key-hierarchy.md)). That cannot express "Rahul and Priya
can both read the Finance folder" without the server learning a key.

Sharing in a zero-knowledge system needs public-key cryptography: each person has a key pair,
and a shared key is handed to someone by encrypting it to their public key. That piece has to
exist on every account before any sharing feature ships, and its format is effectively
permanent — ciphertext written under it cannot be rewritten without its owner present. So it
is decided and built first, with the sharing model it must serve written down beside it.

## Decision

### Identity keys (built now)

**Every account has one ECDH P-256 key pair.**

| | Stored as | Protected by |
|---|---|---|
| Public key | Raw uncompressed point, base64url, 65 bytes, on the profile | Nothing — it is public |
| Private key | PKCS#8, sealed under the vault key with AAD `vault.identity.private.v1` | The vault key, exactly like every entry |

- Generated in the browser at sign-up and sent with the registration. Accounts that predate
  this enrol one on their next unlock (`PUT /api/keys/identity`), quietly.
- **Set once.** The API refuses to replace an existing public key. A silent swap of
  someone's public key is the attack sharing has to resist; rotation will be its own
  deliberate, audited flow that re-shares everything.
- The server checks the public key is a valid point on the curve before storing it.
- A master password change does not touch it: the private key is under the vault key, which
  does not change ([0001](0001-cryptography-and-key-hierarchy.md)).

**Sealing to a recipient** is ECIES from platform primitives (`packages/crypto/src/identity.ts`):

```
ephemeral P-256 key pair (fresh per message)
shared = ECDH(ephemeral private, recipient public)
key    = HKDF-SHA256(shared, salt = ephemeral public || recipient public, info = "vault.share.v1")
blob   = "pk1." || base64url(ephemeral public) || "." || AES-256-GCM(key, plaintext, aad = "vault.share|" || context)
```

- `context` names what is being shared and where (for example `collection-key:<id>`) and
  must be supplied to open it, so a server cannot present a ciphertext made for one purpose
  as another.
- Both public keys are in the HKDF salt, so a blob cannot be replayed as if it were for a
  different recipient.
- **P-256, not X25519:** it is in Web Crypto in every browser this supports, in Node, and in
  Android's keystore, which the Android client must match bit for bit. X25519 support in
  browsers is recent and uneven.
- **Fingerprints** — the first 128 bits of SHA-256 of the public key, as eight groups of
  four hex digits — are what people compare to check a key is really someone's.

There are no published test vectors for this exact composition. Its primitives (ECDH P-256,
HKDF-SHA256, AES-GCM) come from Web Crypto and the HKDF and AES-GCM steps are already pinned
by vectors; the composition is covered by property tests (only the recipient opens, context
and recipient are bound, any tampering fails). When the Android client exists, a
cross-implementation test will fix the format from both sides.

### The sharing model (designed now, built in phase 3)

```
Organization
  └─ Collection ("Finance", "Engineering/AWS", ...)
        collection key  — random 256-bit, one per collection
          ├─ sealed to member A's public key   (context "collection-key:<collection id>")
          ├─ sealed to member B's public key
          └─ encrypts every item in the collection, AES-256-GCM, AAD = item id
Personal vault
  └─ vault key — as today; personal items never move under a collection key
```

- **An item lives in exactly one place**: the personal vault, or one collection. Sharing an
  item means moving it into a collection; it is re-encrypted under the collection key by the
  person moving it.
- **Membership is a sealed collection key.** Adding someone to a collection means an existing
  member seals the collection key to the newcomer's public key. The server stores the sealed
  copy and enforces who may fetch it, but cannot open it.
- **Trusting a public key.** The server hands out public keys, so a hostile server could hand
  out its own and receive what is shared. Joining an organization therefore has a
  confirmation step: the newcomer accepts, an admin sees their fingerprint and confirms them,
  and only confirmed members are ever sealed to. Fingerprints are shown to both sides so they
  can be compared out of band. This is threat A11.
- **Removing someone** stops the server giving them anything new, but they may have kept the
  collection key. Removal therefore rotates the key of every collection they could read: a
  remaining member generates a new key, re-encrypts the items, and re-seals it to everyone
  left. Until that runs, the removed member could read items they already had access to —
  which they could have copied anyway — but nothing added after.
- **Permissions** (view, edit, manage, can-see-password) are enforced by the server on reads
  and writes. Cryptography decides who *can* decrypt; permissions decide who is *served* the
  ciphertext. "Hide password" is a server and client policy, not a cryptographic guarantee,
  and will be labelled so.
- **Organization recovery** — an admin restoring a member who lost both master password and
  recovery key — would require the member's vault key or private key to be sealed to an
  organization key. It is opt-in per organization, visible to members, and decided when
  phase 3 is designed in detail. It is not built by default.

## Consequences

- Every account will have an identity key pair before sharing exists, so phase 3 needs no
  migration of existing accounts.
- The profile gains two fields; `/api/auth/me` returns them; registration accepts them.
- Sealed-to-recipient ciphertext is versioned (`pk1`), like sealed blobs (`v1`), so the
  scheme can change without stranding data.
- A new threat enters the model with sharing: public-key substitution by the server (A11).
  It does not apply yet, because nothing is shared.
