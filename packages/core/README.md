# @vault/core

Logic every Vault client shares and no UI owns: the item model, search, folder trees, import
parsers, CSV export, password health and QR encoding. Plain TypeScript with **no third-party
dependencies and no React**, so the web client today and the browser extension (phase 4)
run the same code.

## Contents

| File | Role |
|---|---|
| `src/items.ts` | `TYPE_SPECS`: what each entry type holds and where each value lives (`at`), `readField`/`writeField`, list `subtitle`, `matches` (search — never over secrets), card helpers, folder trees (`folderTree`, `folderPath`, `descendants`, `MAX_FOLDER_DEPTH = 4`) |
| `src/import.ts` | `readImport(text)`: detects and parses Chrome/Edge/Brave, Firefox, Safari, Bitwarden JSON and CSV, 1Password, LastPass, KeePass, Zoho Vault, and named-column CSV into `ImportedItem`s; RFC 4180 `parseCsv`; `totpKey`; `duplicateKey` |
| `src/export.ts` | `toCsv`: Bitwarden-layout CSV; non-login types become notes with their fields listed |
| `src/health.ts` | `passwordStrength` and `analyse`: weak, reused, old (> 365 days since `passwordChangedAt`), unencrypted site; a 0–100 score |
| `src/qr.ts` | QR encoder for the 2FA enrolment code, checked against vectors from an independent encoder |
| `test/` | Fixtures per import format, a CSV round trip, health cases, QR vectors |

## Contracts

- **Structural typing only.** Functions take `EntryLike`/`HealthInput`, structurally a subset
  of `@vault/crypto`'s `EntryContent`; this package never imports the crypto package.
- **Nothing here touches the network or storage.** Import files arrive as text from the
  caller; results go back to the caller, which encrypts them.
- **Search never matches secret fields** (passwords, card numbers, hidden custom fields).
- Adding an entry type or field is a change here, not in the cryptography: the sealed blob is
  one JSON document either way.

## Used by

`apps/web` (vault, import & export, health, 2FA enrolment). The extension will be the second
consumer.

```sh
npm test --workspace @vault/core
```
