# Vault browser extension: privacy policy

Last updated: 2026-11-25

The Vault extension is a client for a Vault password manager server: yours, your company's,
or one run for you. This policy covers the extension itself.

## What the extension collects

**Nothing for its developer.** There is no analytics, telemetry, crash reporting or
advertising, and the extension contacts no server of ours.

## What it sends, and where

Only to the Vault server you enter at first run:
- your email address, and a key derived from your master password that proves it (never the
  password itself);
- encrypted items, when you save or update a login;
- for shared items, a record that you filled or copied one, which your organization's audit log
  keeps.

Your master password, the keys derived from it and your decrypted items never leave the
extension. The server stores only ciphertext it cannot read.

## What it keeps on your device

- The server address and your settings, in extension storage.
- While unlocked, the keys and session tokens, in session storage. That storage is memory only,
  is cleared when the browser closes or the vault locks, and content scripts cannot read it.
- If your account uses a secret key, that key, under a non-extractable device key.

## Web pages

The extension reads a page only to fill a login you asked it to fill, in the tab you acted in,
or, if you turn on the optional in-page features, to show its icon in login fields and offer to
save a login you submit. A password you submit is held in memory for at most three minutes,
for that site only, so it can offer to save it.

## Your server

What your Vault server keeps is decided by whoever runs it: the activity log, and the audit log
for organizations. Ask them for their policy.

## Contact

Questions: open an issue at https://github.com/SHIVAM-SHARMA-766/vault/issues
