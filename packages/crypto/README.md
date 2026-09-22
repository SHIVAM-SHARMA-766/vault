# @vault/crypto

Every cryptographic operation the vault performs. Key derivation, the sealed-blob
format, entry and folder encryption, and TOTP.

Design and rationale: [decisions/0001](../../decisions/0001-cryptography-and-key-hierarchy.md).

## Two rules this package exists to enforce

**No third-party dependencies.** `dependencies` is empty and stays empty. Every primitive
comes from Web Crypto, which resolves to the browser's implementation in a page and to
Node's in the API and in tests. A compromised transitive package is the most valuable
target in a password manager; there is nothing here for one to compromise.

**No algorithm implemented by hand.** PBKDF2, HKDF, HMAC, and AES-GCM are called, never
written. The code in this package is argument checking, key plumbing, and encoding.

## Test vectors

The primitives are asserted against vectors published by the bodies that define them:

| File | Source |
|---|---|
| `vectors/pbkdf2-sha256.json` | RFC 7914 §11 |
| `vectors/hkdf-sha256.json` | RFC 5869 appendix A |
| `vectors/hmac-sha256.json` | RFC 4231 |
| `vectors/aes-256-gcm.json` | GCM specification, test cases 13–16 |
| `vectors/totp.json` | RFC 6238 appendix B |

They are deliberately **not** generated from this implementation. A vector produced by the
code it tests passes whether or not the code is correct, and would make the planned
Android client agree with this package rather than with the standard. Each file was
cross-checked against Python's `hashlib`/`hmac` and OpenSSL before being committed.

When the Android client is written, it asserts against these same files.

## Public surface

```
Encoding      toBase64Url  fromBase64Url  toHex  fromHex  utf8Encode  utf8Decode
              toRecoveryString  fromRecoveryString      Crockford base32, hyphenated
              toBase32Secret    fromBase32Secret        RFC 4648, for TOTP secrets
              timingSafeEqual   wipe

Primitives    pbkdf2Sha256  hkdfSha256  hmac  hmacSha256  aesGcmEncrypt  aesGcmDecrypt

Sealing       seal  unseal  sealString  unsealString  sealJson  unsealJson
              UnsealError                             every failure, one message

Keys          createAccount  unlock  unlockWithRecoveryKey  changePassword
              rotateRecoveryKey  deriveMasterKey  deriveKek  deriveAuthKey
              wrapVaultKey  unwrapVaultKey  normalizeEmail

Entries       sealEntry  openEntry  sealFolder  openFolder  isWithinSizeLimit

TOTP          generateTotp  totpFromBytes  parseOtpauthUri
```

## Sealed-blob format

```
v1.<base64url(iv)>.<base64url(ciphertext || tag)>
```

AES-256-GCM, a fresh 96-bit IV per operation. The version prefix is what allows the
scheme to change later: a v2 can be introduced while v1 blobs remain readable, which is
the only way to migrate data that is already encrypted.

Callers pass additional authenticated data identifying what is being sealed — an entry
id, a wrapped key's purpose. A server holding the ciphertext therefore cannot move a blob
to a different record without the authentication tag failing.

## Usage

```ts
import { createAccount, sealEntry, openEntry, unlock } from '@vault/crypto'

// Registration. Everything except vaultKey and recoveryKey goes to the server.
const account = await createAccount(masterPassword)
// Show account.recoveryKey exactly once, then discard it.

// An entry. The id is bound into the ciphertext.
const blob = await sealEntry(entryId, { name: 'GitHub', type: 'login', /* ... */ }, account.vaultKey)

// Login. Throws UnsealError on a wrong password, without asking the server.
const { vaultKey, authKey } = await unlock(password, kdf, wrappedVaultKey, salt)
const entry = await openEntry(entryId, blob, vaultKey)
```

## Development

```sh
npm run typecheck      # no emit
npm run build          # tsc to dist/
npm test               # build, then node --test
npm run test:coverage   # same, without source maps
```

Coverage is built without source maps because Node 20's coverage reporter fails on them.

Tests use a reduced PBKDF2 iteration count where they are exercising structure rather
than the parameter itself; the production value of 600,000 is asserted separately.
