# 0039: Travel mode

Status: Accepted by the operator on 2026-11-27; built
Date: 2026-11-27
Builds on: [0038](0038-several-vaults.md)

## Context

1Password's travel mode removes every vault not marked "safe for travel" from all of a person's
devices, so a device checked at a border shows only what they chose. With separate vaults (0038),
the server knows which entries belong together, so it can do the same.

## Decision

- **Storage.** One `TRAVEL` row per account holds `on` and the vaults that are safe
  (`personal` stands for Personal). Nothing is safe by default. Settings shows which vaults will
  go before travel mode is turned on.
- **While on**, the server:
  - leaves the other vaults' entries and vault records out of `GET /api/vault`, which every client
    reads (web app, extension, CLI, offline copy);
  - answers their history as empty;
  - treats them as missing for every write, delete and move, and for renaming or deleting the
    vault. Nothing is deleted.
- **Turning it on, or hiding more, is free.** Turning it off, or marking another vault safe while
  it is on, needs the master password within the last ten minutes (the sudo window). A device that
  is merely signed in therefore cannot undo it.
- **Personal backups and emergency access are unchanged.** Backups go to the person's own storage,
  not to a device in hand. Emergency access is a separate person's decision, with its own wait.
- **Folders stay visible.** They are account-wide and sealed under the account key. A folder name
  could hint at what is away, so the setting's text says to keep folder names plain.

## Consequences

- It protects against a device being searched, not against someone who forces the master
  password out of you. That is the same limit 1Password states.
- A client that cached items before travel mode was turned on keeps them until it reloads. The web
  app holds nothing on disk. The extension drops its cache when it locks.
