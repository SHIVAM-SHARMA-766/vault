# 0020: File attachments, and an offline copy

Status: Accepted
Date: 2026-11-08
Builds: [0001](0001-cryptography-and-key-hierarchy.md), [0017](0017-personal-backups.md)

## Context

People keep scans, licence files and recovery sheets next to their logins, and Zoho Vault and
1Password both allow attachments. People also asked to open their vault when the server is
unreachable, without trusting another service with a copy.

## Decision

**Attachments: a fresh key per file, kept inside the sealed entry.** The browser encrypts each
file with AES-256-GCM, using a new 32-byte key and the attachment id as associated data
(`vault.attachment.v1:<id>`), and uploads only the ciphertext (`PUT /api/attachments/:id`).

- The key, file name, type and size are stored in the entry's `attachments` list, which is
  sealed with the vault key like the rest of the entry. The server holds ciphertext, its size
  and a time. It cannot tell which entry a file belongs to, what it is called, or what it holds.
- **Limits:** 2 MB per file, so a sealed upload stays under the 4 MB request limit, and 100 MB
  per account.
- Attachments are never replaced in place. A new version is a new attachment.
- Removing a file from an entry, or deleting the entry, deletes it on the server. Deleting the
  account deletes all of them.
- **Personal backups carry the attachment files.** A restore puts them back under their own ids,
  and the keys come back with the entries.
- Encrypted exports and share links leave them out, because the other end would hold references
  to files it does not have.
- **Personal items only, for now.** Sharing an item that has attachments is refused with an
  explanation. Moving the file into an organization would need a copy encrypted under the
  collection's key that every member can fetch; that is the next step, not this one.

**The offline copy: one HTML file.** Settings → Backups → *Download an offline copy* writes the
account's encrypted entries and folders, its KDF settings and its wrapped vault key into a single
HTML file. The file also contains the offline script, built from the same `@vault/crypto` and
`@vault/core` code as the app.

- It opens from disk in any modern browser with the master password, which was current when it
  was made, and decrypts as the app does.
- The file's own Content-Security-Policy allows only that script (by hash) and no network at all.
- It is read-only and leaves out attachments.
- The served site never runs it: the bundle is fetched and assembled into the file in the
  browser, so the site's no-inline-script policy is unaffected.

## Rejected

- **One key for all attachments, or the vault key.** A per-file key means a leaked file key opens
  one file, and lets a future "share this file" hand over one key.
- **Storing attachments in object storage.** It would add a moving part and another credential.
  At these sizes the database rows are fine. An operator who needs more can revisit this.
- **A server-hosted "offline mode".** If the server is the thing that is gone, that does not
  help. A file the person holds does.
- **A browser extension or desktop app for offline use.** That is phase 4 and later. The HTML file
  works today on any device.

## Consequences

- An offline copy is as strong as the master password at the time it was made. A stolen file
  allows offline guessing, exactly like a stolen database row (threat A2). The page says so.
- Changing the master password does not change copies already made.
- Attachments count against the database's size. The admin's metrics show item counts, not
  bytes. Watch the database volume.
