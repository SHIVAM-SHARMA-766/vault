# @vault/api

The vault's API. One Lambda function behind a Function URL, reachable only through
CloudFront.

Design: [decisions/0001](../../decisions/0001-cryptography-and-key-hierarchy.md) for what
the server is and is not told, [decisions/0002](../../decisions/0002-storage-and-data-model.md)
for the table, [docs/threat-model.md](../../docs/threat-model.md) for what it defends
against.

## What the server knows

Nothing it could use. It holds ciphertext, an scrypt verifier of a key derived through a
branch that cannot be worked backwards, and an HMAC digest of the account's address.

- **The master password never arrives.** The client sends an **Auth Key**, a separate
  HKDF branch of the master key. Seeing every Auth Key ever sent reveals nothing about
  the key that decrypts the vault.
- **Entry contents, names, tags, and folder membership are all inside one sealed blob.**
  The API validates that a blob has the right shape and size. It cannot validate anything
  about its contents, and does not try.
- **Addresses are stored as `HMAC-SHA256(pepper, email)`.** A dump of the table says how
  many accounts exist, not whose.

## Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | — | Liveness |
| POST | `/api/auth/prelogin` | — | The KDF salt for an address; a decoy for unknown ones |
| POST | `/api/auth/register` | — | Create an account, if registration is open |
| POST | `/api/auth/login` | — | Exchange an Auth Key for a session and the wrapped vault key |
| POST | `/api/auth/recovery-login` | — | The same, using the recovery key's own proof |
| POST | `/api/auth/refresh` | refresh | Rotate the session |
| POST | `/api/auth/logout` | access | Revoke one session, or all |
| GET | `/api/auth/me` | access | Profile and KDF parameters |
| POST | `/api/auth/change-password` | access | Rewrap the vault key under a new password |
| POST | `/api/auth/recovery/rotate` | access | Issue a replacement recovery key |
| GET | `/api/vault` | access | The whole vault, in one query |
| PUT/DELETE | `/api/vault/entries/:id` | access | One entry |
| PUT/DELETE | `/api/vault/folders/:id` | access | One folder |
| GET/POST | `/api/vault/history/:id` | access | Previous versions, capped at twenty |
| GET | `/api/activity` | access | Security events, expired after ninety days |

## Decisions worth knowing before changing anything

**Tokens are not JWTs.** A JWT names its own algorithm in a header the verifier is then
expected to trust, which is the root of the "alg: none" and algorithm-confusion bugs.
These tokens are `v1.<payload>.<HMAC-SHA256>` with one algorithm, named nowhere, and
therefore not negotiable.

**Refresh tokens rotate, and a replay revokes everything.** A refresh token presented
twice means the legitimate client already rotated it away — the signature of a stolen
one. Every session is dropped; the owner signs in again, the thief cannot.

**An unknown address and a wrong password are indistinguishable.** Same status, same
body, and the verifier runs against a dummy so the timing matches too. `prelogin` returns
a decoy salt derived under the pepper, stable per address and uniformly distributed.
Breaking any of this turns the login endpoint into an account-enumeration oracle.

**Registration is closed unless `ALLOW_REGISTRATION=true`.** A missing or misspelled
setting refuses rather than leaving the vault open to whoever finds the URL. Open it for
the first signup, then close it.

**The iteration floor is enforced server-side.** The client is the thing an attacker
controls; a registration claiming 1,000 iterations would leave the wrapped vault key open
to offline attack.

**`Scan` is not in the IAM policy and no code path needs it.** Every read is a query on
one user's partition or a point lookup.

## Development

```sh
npm run typecheck
npm test            # 47 tests against an in-memory store — no AWS needed
npm run bundle      # single-file ESM for Lambda
```

The tests drive the real routes through an in-memory `Store` with the same semantics the
DynamoDB one provides: point lookups, conditional writes, sort-key prefix queries, and
atomic counters. `store-dynamo.ts` is the only module without coverage, because it is the
adapter those semantics are borrowed from.
