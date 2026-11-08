# 0027: An opt-in secret key in the key derivation

Status: Accepted; implemented 2026-11-08, opt-in per account
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

## As built

- **Derivation** as above: `stretched = PBKDF2(password, salt, iterations)`,
  `expanded = HKDF(secretKey, empty salt, "vault.secret-key.v1")`,
  `masterKey = HKDF(stretched XOR expanded, empty salt, "vault.master.v2")`. Known-answer vectors
  in `packages/crypto/test/secretkey.test.ts` were computed independently with Python's hashlib.
- **Format:** `SK1-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX` instead of the sketch above:
  Crockford base32 of the 16 key bytes plus the first 4 bytes of their SHA-256 as a checksum
  (32 characters in groups of four, like the recovery key). Parsing forgives case, grouping, a
  missing prefix and the I/L/O look-alikes; a wrong checksum is reported as a typo before
  anything is derived or sent.
- **Where:** Settings → *Account* (next to the master password and recovery key), not
  Security. Turning it on or off is `POST /api/auth/change-password` with the same password and
  `kdf.version` 2 or absent. The server audits it as `add-secret-key` / `remove-secret-key`.
- **On the device:** IndexedDB `vault-device`, sealed with a non-extractable AES-GCM key
  (aad `vault.secret-key.device.v1`), one slot per normalised address. It is written before the
  server is changed, so a failed request cannot leave an account needing a key nobody holds.
- **Downgrade guard:** if a browser holds a secret key for an address and prelogin answers
  without `version: 2`, sign-in stops before any auth key is sent. Otherwise a hostile server
  could collect a password-only auth key and guess offline. The person can choose to forget the
  key on that browser, for when they removed it elsewhere.
- **Enumeration:** prelogin for an unknown address answers `version: 2` for about one address
  in eight (HMAC under the pepper, stable per address), so the flag does not prove an account
  exists.
- **Recovery reset:** keeps the secret key when the browser holds it; otherwise the new
  derivation has none, which is how a person who lost the key gets back in.
- **Also covered:** a master password change keeps the key; an offline copy asks for it; a
  personal backup opens with this browser's copy or the recovery key.
- **Not built:** handing the key to a new device by QR code (typed from the kit for now).
