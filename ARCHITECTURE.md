# Architecture

The system the decisions in [`decisions/`](decisions/) add up to. This describes the
**target**; see [STATUS.md](STATUS.md) for what is actually built, which at present is
nothing.

The companion documents are [decisions/0001](decisions/0001-cryptography-and-key-hierarchy.md)
for the cryptographic scheme, [decisions/0002](decisions/0002-storage-and-data-model.md)
for the data model, and [docs/threat-model.md](docs/threat-model.md) for the adversaries
the shape is chosen against.

## Shape

Static assets on object storage behind a CDN, a serverless function for the API, and a
key-value store. Nothing runs continuously, and there is no host to patch.

```
        Browser  ── master password, Master Key, Vault Key, plaintext
           │        all live here and nowhere else
           │
           │  HTTPS
           ▼
      CloudFront ─────────────► S3  (private, Origin Access Control)
           │                         built SPA assets
           │  /api/*
           ▼
   Lambda Function URL
           │
           ├──────► DynamoDB   single table, ciphertext only
           ├──────► SSM        server pepper, token signing key
           └──────► S3         scheduled encrypted export
```

Two AWS services are deliberately absent. **API Gateway** is replaced by a Lambda Function
URL, because its free tier expires after twelve months while Lambda's does not.
**Secrets Manager** is replaced by SSM Parameter Store, because it bills per secret per
month.

S3 is never exposed directly. Its website endpoint serves plaintext HTTP only, and
delivering this application over HTTP would defeat the entire design — an attacker on the
path could replace the code that handles the master password. CloudFront is the sole
entry point and the bucket is reachable only through an Origin Access Control.

## Where trust ends

Everything below the browser is assumed hostile. A complete compromise of the AWS account
should yield ciphertext and nothing more.

That assumption drives three choices that would otherwise look excessive:

- The master password is never transmitted. The server receives an **Auth Key**, a
  separate HKDF branch of the Master Key, and stores only a scrypt verifier of it.
- All entry content is encrypted client-side, including names, tags, and folder names.
  The server cannot read, search, or index any of it.
- Email addresses are stored as HMAC digests under a pepper held outside the database, so
  a table dump does not identify account holders.

## Key hierarchy

```
Master Password + per-user salt
        │ PBKDF2-SHA256, 600k
        ▼
   Master Key ──┬── HKDF "vault.kek.v1"  ──► KEK ──► wraps Vault Key
                └── HKDF "vault.auth.v1" ──► Auth Key ──► server (scrypt verifier)

   Vault Key (random, generated once, never rotates)
        ├── wrapped by KEK                  (master password path)
        └── wrapped by Recovery KEK         (recovery key path)
        └── encrypts every entry field, AES-256-GCM, fresh 96-bit IV
```

The indirection through the Vault Key is what makes a master password change a **single
write**: re-derive the KEK, rewrap the Vault Key, store the new salt and verifier.
Entries are untouched and history survives. Encrypting entries directly under a
master-derived key would make the same operation a rewrite of the whole vault — which
cannot be done atomically in DynamoDB past 100 items.

## Data

One table. One partition per user. No secondary indexes, because the only two reads are a
partition query and a point lookup.

| PK | SK | Holds |
|---|---|---|
| `USER#<id>` | `PROFILE` | KDF parameters, auth verifier, both wrapped Vault Keys |
| `USER#<id>` | `ENTRY#<id>` | One encrypted entry |
| `USER#<id>` | `FOLDER#<id>` | Encrypted folder name and parent |
| `USER#<id>` | `HIST#<entryId>#<ts>` | Prior versions, capped at 20 |
| `USER#<id>` | `ACT#<ts>#<rand>` | Activity record, expired by TTL at 90 days |
| `EMAIL#<hmac>` | `EMAIL` | Login pointer to a user id |

Unlocking the vault is one `Query`. Everything after that — search, filter, sort, folder
resolution — happens in the client, because the server cannot read what it is storing.

## Request flow

**Registration.** The client generates a Vault Key and a recovery key, derives the Master
Key from the chosen password and a fresh salt, wraps the Vault Key twice, and sends the
salt, the Auth Key, and both wrapped blobs. The recovery key is displayed once and never
transmitted.

**Login.** The client requests the salt for an email address; unknown addresses receive a
deterministic decoy so the endpoint cannot be used to enumerate accounts. It derives the
Master Key, sends the Auth Key, receives a short-lived access token and the wrapped Vault
Key, and unwraps it locally.

**Reading.** One query returns the partition. The client decrypts in memory. Keys are
discarded on logout, tab close, and idle timeout; nothing sensitive reaches browser
storage, so a reload requires unlocking again.

**Writing.** The client encrypts, then writes the item. The server validates shape, size,
and ownership — it cannot validate content.

## Repository layout

Planned; directories appear as each is built.

| Path | Contents |
|---|---|
| `packages/crypto/` | Key derivation, wrapping, entry encryption, TOTP. Zero third-party dependencies. Built first — everything else depends on it |
| `packages/crypto/vectors/` | Test vectors from RFC 6070, RFC 5869, NIST CAVP, RFC 6238. Asserted by every client implementation in CI |
| `services/api/` | The Lambda handler |
| `apps/web/` | The vault SPA |
| `infra/` | Terraform for the AWS resources |
| `decisions/` | Architecture decision records |
| `docs/` | Threat model and operational runbooks |

The cryptography package is deliberately a separate package with no dependencies and full
test coverage. It is the one component where a defect is unrecoverable — ciphertext
written under a broken scheme cannot be repaired afterwards — and the one that a second
implementation, the planned Android client, has to match exactly. Its test vectors are
taken from published standards rather than generated from this implementation, so that
"both clients agree" cannot quietly mean "both are wrong in the same way".
