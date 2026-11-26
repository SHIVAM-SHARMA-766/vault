# 0034: Unlock with a passkey (PRF)

Status: Accepted by the operator on 2026-11-25 ("pick the next task and complete it"); built
Date: 2026-11-25
Implements: [0022](0022-passkeys.md) (b). Backlog: D9.

## Context

0022 accepted passkeys in three senses and built (a), a second factor. It put (b) next: an opt-in
"Unlock with a passkey", PRF only, with the key-wrapping written up before code. This is that
write-up.

In this app, locking signs the browser out (the vault key lives only in memory, and lock ends the
server session). So "unlock with a passkey" means **signing in with a passkey**, with no email
and no master password typed.

## Decision

### Keys

```
Passkey (discoverable WebAuthn credential, user verification required)
      | PRF("vault.passkey-unlock.prf.v1"), computed inside the authenticator
      v
PRF output (32 bytes per credential; never leaves the browser)
      | HKDF-SHA256, empty salt, info "vault.passkey.kek.v1"
      v
Passkey KEK ── wraps the Vault Key   (AAD "vault.wrap.passkey.v1|<credential id>")
           └── seals the email       (AAD "vault.email.passkey.v1|<credential id>")
```

- **The same Vault Key.** This is one more wrapping beside the master and recovery ones
  (0001). Removing a passkey deletes its copy and re-encrypts nothing. Changing the master
  password leaves passkeys working.
- **A constant PRF input.** It is not secret: the authenticator mixes it with a secret of its
  own, so each credential gives a different output.
- **The email is sealed.** The server keeps only a keyed digest of addresses, and a passkey
  sign-in starts without anyone typing one.
- **Bound to the credential.** Both blobs carry the credential's id as additional data, so the
  server cannot hand one passkey's blob to another.

Code: `packages/crypto/src/passkey.ts`, with a known-answer test.

### Adding one (Settings → Security → Unlock with a passkey)

1. The master password is proved, as for adding a security key.
2. The server issues registration options. The credential must be discoverable
   (`residentKey: required`) and must verify its user (`userVerification: required`). The
   browser asks for PRF and names the credential with the account's email.
3. The browser gets the PRF output, from the creation itself or from one more touch with a local
   challenge that is never sent. If there is none, the passkey is not saved, and the person is
   told why and to delete it from the device.
4. It wraps the vault key and the email, checks that the wrapping opens, and sends the
   registration with both blobs. The server verifies the registration, user verification
   included, and stores it.

At most 10 per account. An unlock passkey is separate from second-factor keys: neither list
accepts a credential from the other, and an unlock passkey does not turn two-factor on.

### Signing in

1. `POST /api/auth/passkey-login/options` returns a challenge with no allowed credentials, so
   the browser offers its own Vault passkeys. Nothing names an account, so nothing can be
   probed (A7). The challenge is stored for five minutes.
2. `POST /api/auth/passkey-login` takes the assertion. The server:
   - finds the challenge, and claims it once with a conditional write;
   - finds the account from the credential's user handle, and the passkey among its unlock
     passkeys;
   - verifies the signature with user verification required, and records the counter;
   - then applies the same checks as a password sign-in: the network allow-list (G2) and a
     disabled account (B9).

   It returns a session and the passkey's blobs. The browser opens them with the PRF output.
3. **No second factor is asked for.** A passkey with user verification is already two factors:
   the device, plus its PIN or biometric. It answers only this server's address. The server
   policy "require two-factor" (G1) is satisfied by it, as by any WebAuthn sign-in.

**Rate limits.** The same per-address limit as a password sign-in applies to both requests. The
per-account limit applies to the second, once the account is known.

**Activity.** Records `add-passkey`, `remove-passkey` and `passkey-login`. No sign-in email is
sent: the server does not have the address at that point.

### Removing one

Removing one needs only the session: taking a way in away weakens nothing.

## Threat model

- **Equivalent to the master password for that vault.** Anyone who can use the passkey (the
  device and its PIN or biometric) can open the vault. The card says so before adding, and the
  option is opt-in per passkey.
- **A synced passkey** (iCloud Keychain, Google Password Manager) is as safe as that account.
  This is the person's choice. A hardware key is the conservative option.
- **The server never sees the PRF output.** A database dump holds a blob wrapped under a 256-bit
  key, which cannot be guessed offline. A dumb password is not the weak point here.
- **A hostile server** could refuse to verify, or return a wrong blob. Either way the result is
  that nothing opens. It cannot make a passkey open another account, because the blob is bound to
  the credential and the browser's PRF output is per credential.
- **If someone else adds a passkey**, it needs the master password and an unlocked session.
  It appears in Settings → Security and in activity, and removing it ends it.

## Not done here

- **The browser extension** still signs in with the master password. Passkey sign-in there is
  0029's stage 5.
- **Storing passkeys for other sites** is 0022 (c), with the extension.

## Tests

- **crypto:** known answer for the KEK; round trip; another PRF output, another credential, or
  swapped blobs fail.
- **API:**
  - enrolling needs the password and user verification, does not turn two-factor on, and
    refuses a duplicate;
  - sign-in names no account, returns the blobs, and uses each challenge once;
  - it is refused without user verification, with an unknown or second-factor credential, with
    another account's handle, or with a stale challenge;
  - the allow-list, disabled accounts, removal and the rate limit apply.
- **e2e:** with Chromium's virtual authenticator (PRF, resident key, user verification):
  - add, lock, sign in with the passkey alone, see an item decrypted and the right account, then
    remove it, after which it no longer signs in;
  - without PRF, nothing is saved and the person is told why.
