# 0028: Argon2id for the master password

Status: Accepted (design); follows 0027
Date: 2026-11-08
Implements: [0023](0023-crypto-hardening.md) §3

## Design

- **Parameters:** Argon2id with m = 64 MiB, t = 3, p = 1, and a 32-byte output. That is OWASP's
  2025 guidance for interactive logins, and about a second on a mid-range phone.
- **Stored per account:** `kdf: { algorithm: "argon2id", m, t, p, salt }` beside today's
  `PBKDF2-HMAC-SHA256`. The server never runs it; it stores and returns parameters as it does now.
- **WebAssembly, vendored:** a WASM build of the reference implementation, compiled reproducibly
  in CI from pinned source with its checksum committed. No CDN. It is served same-origin, and the
  CSP gains `'wasm-unsafe-eval'` for the app only.
- **Migration:** at the next master password change, or a one-click *Upgrade key derivation*
  that needs the master password. It re-wraps the vault key as a password change does.
- The personal-backup and offline-copy openers accept both algorithms.
- The import-file key-settings bounds (refusing absurd parameters, 0017) extend to the Argon2id
  ranges.

## Tests

- RFC 9106 test vectors for the WASM build
- an account upgraded from PBKDF2 keeps every item
- the offline copy and backups open in both formats
- refusal of absurd parameters
