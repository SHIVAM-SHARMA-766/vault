# 0027: An opt-in secret key in the key derivation

Status: Accepted (design), opt-in per account
Date: 2026-11-08
Implements: [0023](0023-crypto-hardening.md) §2

## Design

A 128-bit **secret key**, generated on the device and never sent, is mixed into key derivation:

```
masterKey = HKDF-SHA256(PBKDF2(password, salt, iterations) XOR HKDF(secretKey, info "vault.secret-key.v1"), info "vault.master.v2")
```

- `kdf.version = 2` marks accounts that have one. The rest of the hierarchy (0001) is unchanged:
  the master key still derives the auth key and the KEK.
- **Format:** `A3-XXXXXX-XXXXXX-XXXXX-XXXXX-XXXXX-XXXXX` (Crockford base32 with a checksum).
  It is shown once in an **Emergency Kit** (a printable page: server address, email, secret key,
  and a blank line for the master password).
- **Turning it on:** Settings → Security → *Add a secret key*. This needs the master password.
  It re-derives with the secret key and re-wraps the vault key under the new KEK. No item is
  re-encrypted. It is the same operation as a master password change, with the same
  sign-out-other-devices effect.
- **Each new device:** sign-in asks for the secret key once (typed, or by QR code from a signed-in
  device) and keeps it in that browser's storage, sealed with a device key it never exports.
- **Losing it:** the recovery key path (0001) is unaffected, because the recovery key unwraps the
  vault key on its own. A person who loses the secret key signs in with the recovery key and can
  then turn the secret key off or issue a new one.
- **Turning it off:** re-derive without it, which means re-wrapping the vault key again.

## Tests

- known-answer derivation with and without a secret key
- turning it on and off keeps every item readable
- sign-in on a new device asks for the secret key, and a wrong one fails like a wrong password
- the recovery key opens an account whose secret key is lost
