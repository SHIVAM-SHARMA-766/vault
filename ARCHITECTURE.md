# Architecture

One always-free virtual machine, one always-free MySQL HeatWave database holding a single
table, one object storage bucket. No
CDN, no serverless functions, no second provider. The whole system is small enough that a
new reader can hold all of it at once, which is deliberate.

This describes the **target**. [STATUS.md](STATUS.md) says what is actually built.

The reasoning lives in [`decisions/`](decisions/): [0001](decisions/0001-cryptography-and-key-hierarchy.md)
for the cryptographic scheme, [0002](decisions/0002-storage-and-data-model.md) for the
data model, [0003](decisions/0003-running-everything-on-oci.md) for why everything sits on
one provider, and [docs/threat-model.md](docs/threat-model.md) for the adversaries the
shape is chosen against.

## Shape

```
        Browser  ── master password, Master Key, Vault Key, plaintext
           │        all live here and nowhere else
           │
           │  HTTPS
           ▼
   ┌──────────────────────────────────────────┐
   │  One always-free instance                │
   │                                          │
   │  Caddy ──┬── /       → built client      │
   │          │              from disk        │
   │          └── /api/*  → Node, localhost   │
   │                          │               │
   └──────────────────────────┼───────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
      MySQL HeatWave                  Object Storage
      ciphertext only                 daily encrypted exports
```

Caddy terminates TLS with a certificate it obtains itself, serves the client from disk,
sets every security header, and proxies `/api/*` to the Node process beside it. The client
and the API therefore share an origin with nothing in front of them — which is what lets
the Content-Security-Policy restrict `connect-src` to `'self'`.

The instance authenticates to Object Storage **as itself**, through a dynamic group that
matches its OCID. The database is reached inside the VCN with a password that, like the
email pepper and the token signing key, lives in `/srv/vault/api/run/secrets.env` on the
host and never in the repository.

## Where trust ends

Everything below the browser is assumed hostile. A complete compromise of the server
should yield ciphertext and nothing more.

That assumption drives three choices that would otherwise look excessive:

- The master password is never transmitted. The server receives an **Auth Key**, a
  separate HKDF branch of the Master Key, and stores only an scrypt verifier of it.
- All entry content is encrypted client-side, including names, tags, and folder names.
  The server cannot read, search, or index any of it.
- Email addresses are stored as HMAC digests under a pepper kept outside the database, so
  a dump does not identify account holders.

**One thing sits outside that boundary and should be understood plainly.** The hostname is
a free dynamic-DNS name, and it is the whole user-facing trust path. Whoever controls that
name can obtain a certificate for it and serve their own JavaScript — which sees the
master password. Unlike a compromise of the server, that is not bounded by the key
hierarchy. It is accepted knowingly; see A3 in the threat model.

## Key hierarchy

```
Master Password + per-user salt
        │ PBKDF2-SHA256, 600k
        ▼
   Master Key ──┬── HKDF "vault.kek.v1"  ──► KEK ──► wraps Vault Key
                └── HKDF "vault.auth.v1" ──► Auth Key ──► server (scrypt verifier)

   Vault Key (random, generated once, never rotates)
        ├── wrapped by KEK                  (master password path)
        ├── wrapped by Recovery KEK         (recovery key path)
        └── encrypts every entry field, AES-256-GCM, fresh 96-bit IV
```

The indirection through the Vault Key is what makes a master password change a **single
write**: re-derive the KEK, rewrap the Vault Key, store the new salt and verifier. Entries
are untouched and history survives.

The recovery key has a second branch of its own, `vault.recovery.auth.v1`, so it can prove
itself to the server without revealing the branch that unwraps the vault. Recovery happens
exactly when the master password is gone, so the usual Auth Key cannot be produced.

## Data

One table. One partition per user. No secondary indexes, because the only two reads are a
shard-key query and a point lookup.

| `pk` | `sk` | Holds |
|---|---|---|
| `USER#<id>` | `PROFILE` | KDF parameters, auth verifier, both wrapped Vault Keys |
| `USER#<id>` | `ENTRY#<id>` | One encrypted entry |
| `USER#<id>` | `FOLDER#<id>` | Encrypted folder name and parent |
| `USER#<id>` | `HIST#<entryId>#<ts>` | Prior versions, capped at twenty |
| `USER#<id>` | `ACT#<ts>#<rand>` | Activity record, expires itself |
| `USER#<id>` | `SESSION#<tokenId>` | A live refresh token, expires itself |
| `EMAIL#<hmac>` | `EMAIL` | Login pointer to a user id |

Unlocking is one query. Everything after that — search, filter, sort, folder resolution —
happens in the client, because the server cannot read what it is storing.

## Request flow

**Registration.** The client generates a Vault Key and a recovery key, derives the Master
Key from the chosen password and a fresh salt, wraps the Vault Key twice, and sends the
salt, the Auth Key, the recovery proof, and both wrapped blobs. The recovery key is
displayed once and never transmitted.

**Login.** The client requests the salt for an email address; unknown addresses receive a
deterministic decoy, so the endpoint cannot be used to enumerate accounts. It derives the
Master Key, sends the Auth Key, receives a short-lived access token and the wrapped Vault
Key, and unwraps it locally.

**Reading.** One query returns the partition. The client decrypts in memory. Keys are
discarded on logout, tab close, and idle timeout; nothing sensitive reaches browser
storage, so a reload requires unlocking again.

**Writing.** The client encrypts, then writes the item. The server validates shape, size,
and ownership — it cannot validate content.

## Repository layout

Everything this project is lives here. Nothing about it lives anywhere else.

| Path | Contents |
|---|---|
| `packages/crypto/` | Key derivation, wrapping, entry encryption, TOTP. Zero third-party dependencies |
| `packages/crypto/vectors/` | Test vectors from RFC 6070, RFC 5869, RFC 4231, NIST, RFC 6238 |
| `services/api/` | The API, and the storage adapters behind one interface |
| `apps/web/` | The vault client |
| `infra/` | Terraform for the instance, the table, the bucket, and the network |
| `decisions/` | Architecture decision records |
| `docs/` | Threat model and runbook |

The cryptography package is deliberately separate, dependency-free, and fully covered. It
is the one component where a defect is unrecoverable — ciphertext written under a broken
scheme cannot be repaired — and the one that a second implementation, the planned Android
client, has to match exactly. Its test vectors come from published standards rather than
from this implementation, so that "both clients agree" cannot quietly mean "both are wrong
in the same way".
