# 0036: Sign in to the account, then unlock with the master password

Status: Accepted by the operator on 2026-11-26; built
Date: 2026-11-26

## Context

Until now one secret did everything: the master password derived the key that opens the vault
*and* the proof that signed in. Whoever learned it had the account and, with the server's
wrapped key, the vault. The operator asked for the Zoho Vault model:
- first sign in to the account (email, an account password, two-factor);
- then the master password opens the vault.

The operator chose:
- **Vault's own account**, not a separate dev2ops.in identity service;
- existing accounts **set an account password at their next sign-in**;
- a forgotten account password is **reset by an emailed link**.

## Decision

**Two secrets, two steps, both checked by the server.**

```
1. account:  email + account password (+ two-factor, or single sign-on)
             → an account token, kept by this browser
2. vault:    account token + proof of the master password
             → a vault session and the wrapped vault key, opened in the browser
```

- **The account password** becomes a proof in the browser: Argon2id (19 MiB, t=2) with its own
  salt, then HKDF `vault.account.v1`. The server stores a slow hash of that proof and never sees
  the password. Its salt is not the master password's and neither is its label, so the proof is
  unrelated to the vault's keys even if someone typed the same text. The apps refuse that anyway:
  - at sign-up they compare the two;
  - elsewhere they send `masterCheck`, the auth key the new account password would give as a
    master password, which the server tests against the real one.
- **The account token** is long-lived (30 days, sliding, capped by the session policy G1). It is
  recorded per device and kept in the browser's storage, so a lock or a reload asks only for the
  master password. It is **not an access token**: no route accepts it except
  `/api/auth/unlock`, the session check and sign-out. It never yields the wrapped vault key
  without the master password's proof.
- **Unlock** checks the master password's auth key against the account's verifier, as the old
  sign-in did, and issues the ordinary short vault session.
  - The account token is replaced on every unlock. A replaced token presented again means a copy
    exists, so every sign-in of that account ends.
  - A wrong master password keeps the account sign-in, and the per-account limit counts the
    attempt.
- **Two-factor** belongs to the account step. A reload does not ask for the code again, as in
  Zoho.
- **Single sign-on** (0021) is an account step: the provider's ticket stands in for the account
  password. "Require single sign-on" now applies there, still with owners exempt.
- **Passkey sign-in** (0034) remains a complete way in on its own: a user-verified passkey is
  already two factors, and its PRF key opens the vault.
- **The recovery key** still replaces the master password, after the second factor.

**Accounts from before.** Their master password still signs in once, through *First sign-in since
accounts were added?*. The server answers with `needsAccountPassword`, and the app asks for an
account password before the vault opens. From then on `/api/auth/login` refuses that account with
`account_password_required`, said only after the master password was proved. The account
prelogin gives the same decoy settings to an unknown address and to an account without an account
password, so it reveals neither.

**Forgotten account password:**
- **By email.** `/api/auth/account/forgot` always gives the same answer. If the account exists
  and mail is set up, it sends a link with a single-use 30-minute code in the URL fragment. Using
  it sets a new account password and signs out every device.
- **By an administrator** (Users → *Reset account password*, audited), for a server without mail.
  It clears the account password; the person signs in once with the master password and chooses
  another.
- Neither touches the vault: the master password still cannot be reset by anyone.

**What ends account sign-ins:**
- changing or resetting the account password;
- a replayed account token;
- *Sign out of this device*, or "sign out everywhere";
- an administrator's revoke or reset.

A new master password and a recovery-key sign-in end vault sessions only. The old master password
no longer unlocks anything through an account sign-in, and the account password was not lost.

**The browser extension** asks for the account password, then the master password, every time it
unlocks. It keeps its sign-in in session memory and signs the account token out at once. It does
not hold a long-lived account sign-in.

## Threat model

- **A stolen master password alone** no longer opens the vault: the attacker also needs the
  account password and two-factor, or a device's account sign-in.
- **A stolen account sign-in (token)** from a device's storage, by script injection say, gives
  only the right to try master passwords at the server, under the per-account limit. It gives
  neither the wrapped key nor any data.
- **A stolen account password** gives nothing without the master password.
- **The server** sees neither password. A dump holds a hash of the account proof beside the hash
  of the auth key and the wrapped vault key. Offline guessing of the master password is as before
  (A2).
- **The cost:** a second password to remember, and a reset path for it by email, which matters as
  much as the mailbox.

## Tests

- **crypto:** the account proof is stable, salted, and unrelated to the master key from the same
  text.
- **API** (6):
  - register with an account password, then account → unlock;
  - the master password alone is refused, and the account token is not an access token;
  - a wrong master password keeps the sign-in, and a replayed token ends everything;
  - two-factor at the account step only;
  - migration from master-password sign-in, the same text refused, and a change needing the
    current password;
  - email reset: single use, the same answer for unknown addresses, every session ended;
  - an administrator clears it.
- **e2e:**
  - a lock asks only the master password;
  - a wrong master password, then the right one;
  - change in Settings;
  - sign out of the device, then the account step (old password refused, new accepted);
  - the emailed reset link (dev-stack outbox);
  - an administrator clears it, and the person picks a new one (the master password's text
    refused);
  - the existing suites (two-factor, security keys, secret key, SSO, Keycloak, extension) adapted
    to the two steps.
