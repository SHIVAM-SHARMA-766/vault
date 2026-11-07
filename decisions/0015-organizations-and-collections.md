# 0015 — Organizations and collections, as built

Status: Accepted
Date: 2026-11-07
Builds: [0009](0009-identity-keys-and-sharing.md)

## Context

0009 designed sharing — a key per collection, sealed to each member's identity key, members
confirmed by fingerprint. Building it settled details 0009 left open: how organization-level
names are protected, how someone is invited without the server revealing who has an account,
how key versions bind ciphertext, and what the server enforces versus what cryptography does.

## Decision

**Keys.**

| Key | Generated | Sealed to | Encrypts |
|---|---|---|---|
| Org key | by the creator, once | every *confirmed* member (`org-key:<org>`) | the org's name, collection names (AAD binds org and collection ids) |
| Collection key | by the collection's creator; again on rotation | each member granted access (`collection-key:<coll>:v<n>`) | the collection's items (AAD `vault.collection-item.v1:<coll>:<item>:v<n>`) |

An item cannot be presented as another collection's, another item's, or another key
version's. A rotated key opens nothing written before rotation, and the server accepts item
writes only under the current version.

**Membership: invited → accepted → confirmed.**
- An admin invites by email address. The invitation is stored against the address's **digest**
  (in the address's own partition), so the response is the same whether or not the address has
  an account, and the invitation appears when its owner signs in. A plaintext *hint* — the
  organization's display name as the inviter typed it — travels with the invitation so the
  invitee knows what they are joining before they can decrypt anything.
- Accepting records the member's public key **as it was at that moment**.
- An admin confirms by comparing the member's fingerprint out of band, then seals the org key to
  that recorded key. The server refuses to confirm if the account's key has changed since.
  Nothing is ever sealed to an unconfirmed member. This is the mitigation for threat A11.

**Permissions** — `view`, `edit`, `manage` per collection, plus a `hidePasswords` flag — are
enforced by the server on what it serves and accepts. Org admins see every collection's name
(they hold the org key) but open only collections they were granted. "Hide passwords" is
applied by the client and labelled as policy, not encryption.

**An item lives in one place.** Sharing moves it: the client re-encrypts it under the
collection key and deletes the personal copy. Shared items have no version history yet.

**Removal** deletes the member's grants and org membership immediately and marks every
collection they could open `rotationNeeded`. Rotation itself — a new key version, items
re-encrypted, re-sealed to remaining members — is phase 3B step 4.

## Consequences

- One table still: `ORG#<org>` (meta, members, pending invitations, collections, grants),
  `COLLI#<coll>` (items), and pointers under `USER#` and `EMAIL#`.
- The client keeps the identity private key in memory after first use, wiped on lock, like the
  vault key.
- Until rotation ships, a removed member who kept a collection key could decrypt items still
  under that key if they also obtained the ciphertext; the server no longer serves it to them.
  Known issue, closed by step 4.
