# 0038: Several vaults in one account

Status: Accepted by the operator on 2026-11-27; built
Date: 2026-11-27

## Context

The operator asked for what Zoho Vault and 1Password offer: separate vaults in one account,
such as Personal, Work and Family. A vault should be something the server can withhold, so
that travel mode (next) really keeps it off a device. A folder or label inside each item would
hide everything from the server, but then the server could not withhold anything.

## Decision

- **Personal is the account's own vault key.** Entries with no vault id are sealed under it as
  before. Nothing that already exists moves, and no migration is needed.
- **Every other vault has a random 256-bit key.** It is wrapped under the account's vault key,
  with AAD `vault.vaultkey.v1:<id>`. The vault's name and look are sealed under the vault's own
  key, with AAD `vault.vaultmeta.v1:<id>`. This lives in `packages/crypto/src/vaults.ts`, and
  `Keyring` picks the key for an entry from its vault id.
- **The server stores** a `VAULT#<id>` row per vault (the id, the wrapped key and the sealed
  name), plus an optional `vaultId` on each entry row. The server checks that the vault exists
  and belongs to the account. It never changes a vault's wrapped key, and it refuses to delete a
  vault that still has entries. At most 20 vaults besides Personal.
- **A write without a vault id is Personal.** An older client that saves an item therefore leaves
  it where that client can read it; the item ends up moved, never lost.
- **Moving** an item re-seals it and every saved version under the new vault's key. One request
  (`POST /api/vault/entries/:id/move`) replaces them all, and is refused unless every version is
  included. The item keeps its id, history and links.
- **Folders stay account-wide**, sealed under the account key. They organize items across vaults.
- **Everything that reads the vault reads every vault**: the web app, the browser extension, the
  CLI, the offline copy, personal backups (which now carry the vaults) and emergency access. The
  grantee holds the grantor's vault key, so the grantee can open the grantor's other vaults too.

## What the server learns

Which entries are in the same vault (an opaque id), how many vaults there are, and when each is
renamed. It does not learn names, contents or which vault is which. This is entry A21a8 in the
threat model.

## Consequences

- Travel mode can now be built: the server withholds the marked vaults.
- Sharing a whole vault with someone stays with organizations and collections, which already exist.
- An item can be linked only to items it can be seen with: links within personal vaults work, but
  once a vault is withheld its items no longer resolve.
