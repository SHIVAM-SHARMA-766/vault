# Vault

A zero-knowledge password manager. Encryption happens on the device; the server stores
ciphertext it holds no key for.

Built and operated by one person, on infrastructure that must cost nothing.

## Status

**Nothing is deployed and no application code exists yet.** The repository currently
holds the design: the cryptographic scheme, the storage model, and the threat model are
decided and written down. Implementation begins with the cryptography package.

Progress is tracked in [STATUS.md](STATUS.md).

## Why this repository exists

An earlier implementation of this product ran on a single always-on virtual machine with
PostgreSQL behind it. That machine's free allocation was withdrawn, the instance was
reclaimed, and the application stopped. Rebuilding it in place would have carried forward
two things worth leaving behind:

- **It was not actually zero-knowledge.** The master password was transmitted to the
  server and hashed there. The README claimed otherwise.
- **It was shaped for a server that no longer exists** — a long-lived process, a
  relational database, and a reverse proxy on a host someone has to patch.

This is a rewrite from an empty directory, not a port. The old repository is kept for
reference and none of its code is carried over.

## Design

Three documents, in the order worth reading them:

| Document | What it answers |
|---|---|
| [decisions/0001](decisions/0001-cryptography-and-key-hierarchy.md) | How keys are derived, what is encrypted, why the master password change is a single write |
| [decisions/0002](decisions/0002-storage-and-data-model.md) | What the data looks like in DynamoDB and why there are no secondary indexes |
| [decisions/0003](decisions/0003-where-infrastructure-is-defined.md) | Why Terraform lives in a different repository, and what the two share |
| [docs/threat-model.md](docs/threat-model.md) | Who the adversaries are, what stops them, and what is explicitly not defended against |

[ARCHITECTURE.md](ARCHITECTURE.md) describes the system these decisions add up to.

## Security summary

The full account is in the documents above. In short:

- The master password never leaves the device. The server receives an Auth Key derived
  through a separate, non-invertible HKDF branch.
- Everything belonging to an entry is encrypted, including its name, tags, and folder —
  so a database dump does not reveal which services the user holds accounts for.
- A recovery key is issued once at signup and is the only path back from a forgotten
  master password. There is no password reset, because the server cannot perform one.
- Changing the master password rewraps a single key. Entries are never re-encrypted.

The design assumes the entire server side is hostile and aims to leak nothing but
ciphertext under that assumption.

## Cost

Every component sits in a permanently free allowance except object storage, which is the
only accepted charge.

| Component | Service | Cost |
|---|---|---|
| API | Lambda, invoked through a Function URL | Free — 1M requests/month, no expiry |
| Database | DynamoDB, provisioned at 25/25, autoscaling off | Free — 25 GB, no expiry |
| Delivery | CloudFront | Free — 1 TB/month, no expiry |
| Secrets | SSM Parameter Store, standard tier | Free |
| Static assets and backups | S3 | **The only billed line** |

Two services are deliberately avoided: API Gateway, whose free tier expires after twelve
months, and Secrets Manager, which bills per secret per month.
