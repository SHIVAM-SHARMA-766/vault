# Vault

A zero-knowledge password manager. Encryption happens on the device; the server stores
ciphertext it holds no key for.

Built and operated by one person, on infrastructure that costs nothing.

## Status

**Live at https://vault-shivam.duckdns.org**, with registration closed. Cryptography, API,
client, infrastructure and a daily export are all running. [STATUS.md](STATUS.md) is the
live account.

## Why this repository exists

An earlier version of this product ran on a single virtual machine with PostgreSQL behind
it. That machine's free allocation was withdrawn, the instance was reclaimed, and
everything stopped. Rebuilding it in place would have carried forward two things worth
leaving behind:

- **It was not actually zero-knowledge.** The master password was transmitted to the
  server and hashed there. The README claimed otherwise.
- **It was shaped for a server that no longer existed** — a long-lived process, a
  relational database, and a reverse proxy on a host someone had to patch.

This is a rewrite from an empty directory. None of the old code was carried over.

The rewrite was first built for AWS and applied there before being moved; the account
would not let CloudFront reach the function, and the reasoning behind moving rather than
waiting is in [decisions/0003](decisions/0003-running-everything-on-oci.md).

## Design

Four documents, in the order worth reading them:

| Document | What it answers |
|---|---|
| [decisions/0001](decisions/0001-cryptography-and-key-hierarchy.md) | How keys are derived, what is encrypted, why a master password change is a single write |
| [decisions/0002](decisions/0002-storage-and-data-model.md) | What the data looks like and why there are no secondary indexes |
| [decisions/0003](decisions/0003-running-everything-on-oci.md) | Why everything runs on one provider, and what that costs |
| [decisions/0004](decisions/0004-the-access-token-header.md) | Why the access token is not in the `Authorization` header |
| [decisions/0005](decisions/0005-pull-based-releases.md) | How code reaches the host without SSH |
| [decisions/0006](decisions/0006-admin-panel.md) | What the admin panel can and cannot do |
| [decisions/0007](decisions/0007-roles-and-site-editing.md) | Staff roles, and editing the website safely on the vault's origin |

[ARCHITECTURE.md](ARCHITECTURE.md) describes the system those add up to.
[docs/threat-model.md](docs/threat-model.md) says who the adversaries are and which risks
are accepted rather than mitigated. [docs/runbook.md](docs/runbook.md) covers deploying it
and what to do when something breaks.

## Security summary

The full account is in the documents above. In short:

- The master password never leaves the device. The server receives an Auth Key derived
  through a separate, non-invertible HKDF branch.
- Everything belonging to an entry is encrypted, including its name, tags, and folder — so
  a database dump does not reveal which services the user holds accounts for.
- A recovery key is issued once at signup and is the only way back from a forgotten master
  password. There is no password reset, because the server cannot perform one.
- Changing the master password rewraps a single key. Entries are never re-encrypted.

The design assumes the entire server side is hostile and aims to leak nothing but
ciphertext under that assumption.

**One risk is accepted rather than mitigated, and it is the largest one.** The hostname is
a free dynamic-DNS name, which is the whole user-facing trust path — whoever controls it
can serve modified client code and obtain the master password. This is recorded in the
threat model as A3 and revisited in [decisions/0003](decisions/0003-running-everything-on-oci.md);
buying a domain would remove it and remains the cheapest improvement available here.

## Cost

Nothing, on perpetual free allowances rather than expiring trials.

| Component | Service | Allowance |
|---|---|---|
| Host | OCI compute, `VM.Standard.E2.1.Micro` | 2 per tenancy, always free |
| Database | OCI MySQL HeatWave, `MySQL.Free` | 1 always-free DB system, 50 GB |
| Exports and releases | OCI Object Storage, two private buckets | 20 GB, 50,000 requests a month |
| TLS | Let's Encrypt via Caddy | free |
| Hostname | DuckDNS | free |

The one thing to watch is not a bill: an idle always-free instance may be reclaimed. See
the runbook.

## Layout

| Path | Contents |
|---|---|
| `packages/crypto/` | Every cryptographic operation. Zero third-party dependencies |
| `services/api/` | The API and its storage adapters |
| `apps/web/` | The vault client and the admin panel, at `/app/` |
| `apps/site/` | The public website: templates, editable content schema and defaults, and its renderer |
| `services/backup/`, `services/release/` | The daily export, and the host's release pull agent |
| `scripts/` | `release.sh` ships code, `deploy.sh` sets up the host |
| `infra/` | Terraform for everything this runs on |
| `decisions/` | Why things are the way they are |
| `docs/` | Threat model and runbook |

## Development

```sh
npm install
npm test        # 175 tests across the crypto package and the API
```

The API's tests run against an in-memory store, so no cloud account is needed for any of
them.

Shipping is `./scripts/release.sh`: it tests, builds, uploads a release, and the host
installs it within five minutes. See [docs/runbook.md](docs/runbook.md).
