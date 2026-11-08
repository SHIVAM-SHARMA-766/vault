# 0022: Passkeys and security keys

Status: **Proposed**
Date: 2026-11-08
Backlog: D9

## Context

"Passkeys" means three different things here, and they should not be confused:

- **(a)** passkeys and security keys as a **second factor** for signing in to Vault
- **(b)** passkeys **as the way to unlock** Vault, with no master password
- **(c)** Vault **storing passkeys** for other sites, as a password manager does for passwords

## Options

- **(a) WebAuthn as a second factor**, beside TOTP: register one or more authenticators, and
  require one at sign-in. It protects sign-in only, like TOTP, and changes nothing about
  encryption. The work is in the server (challenge, attestation "none", counter checks) and in
  tests with a virtual authenticator, which Chromium's DevTools protocol provides to Playwright.
- **(b) Unlock with a passkey** using the **PRF extension**. The authenticator returns a stable
  secret per credential, which wraps a copy of the vault key, the same way the recovery key
  does. Support is good in current Chrome, Safari and Windows Hello, and patchy elsewhere, so
  the master password stays as the fallback. A lost authenticator is safe; a cloned one opens
  the vault, so each person decides whether to enroll.
- **(c) Storing passkeys** needs the browser extension (phase 4) to answer `navigator.credentials`
  on other sites. It belongs to phase 4, not here.

## Recommendation

1. **(a) now:** WebAuthn second factor, any number of keys, with recovery codes as today.
2. **(b) next**, as an opt-in "Unlock with a passkey" per device, PRF only. Where PRF is
   unavailable the option is hidden, not degraded. Its key-wrapping is written up in this record
   before code.
3. **(c) with the extension.**

## Consequences (if accepted)

- Under (b) the vault key gains another wrapping, one per enrolled passkey. Each wrapping is
  listed in Settings → Security with its device, and can be removed. Removing one means
  re-wrapping nothing, because the wrapped copy is simply deleted.
- Threat model: (b) makes the authenticator equivalent to the master password for that vault.
