# 0028: Argon2id for the master password

Status: Accepted; built 2026-11-25
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

## As built

- **WebAssembly, our own source.** The memory filling is written by hand in
  `packages/crypto/argon2/argon2.wat` (about 250 lines). It is assembled by
  `scripts/build-argon2.mjs` with wabt pinned at 1.0.39 into `src/argon2-wasm.ts` (base64,
  1.4 KB, SHA-256 committed). CI runs the script with `--check` and fails if the bytes differ.
  BLAKE2b, H' and the final tag are TypeScript (`src/argon2.ts`). Each derivation makes a fresh
  instance and zeroes its 64 MiB before dropping it. About 0.45 s in Node on a laptop.
- **Embedded, not fetched.** The module is in the bundle, so there is nothing to serve or
  cache. `'wasm-unsafe-eval'` is added to the app's policy, the Caddyfiles, the offline copy's
  policy and the extension's.
- **New accounts and every password change** use Argon2id. Accounts not yet upgraded see
  *Upgrade key derivation* in Settings → Security: the same password, re-derived. It is
  recorded as `upgrade-kdf` and signs other devices out, as a password change does.
- **If WebAssembly is refused** (an old proxy policy), new keys fall back to PBKDF2 instead of
  failing, and the upgrade card stays hidden.
- **Limits, in the client and the server:** 19–1024 MiB, 1–10 passes with memory × passes at
  least 38,912 (OWASP's lowest settings), and 1–4 lanes. Settings outside them are refused,
  from a server at sign-in and from a backup or offline file.
- **Decoys for unknown addresses** claim Argon2id or PBKDF2, about half each, stably per
  address. Otherwise the algorithm alone would say whether an account exists.
- **Export files** keep PBKDF2 under their own password. Personal backups and the offline copy
  carry the account's settings, so they open with either algorithm.

## Tests

- RFC 9106 test vectors for the WASM build
- an account upgraded from PBKDF2 keeps every item
- the offline copy and backups open in both formats
- refusal of absurd parameters
