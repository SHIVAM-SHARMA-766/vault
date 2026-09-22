# Status

What is in flight. Updated when something starts, stalls, or finishes.

Last updated: 2026-09-22

## Right now

**The project moved to OCI, and everything about it now lives in this repository.**
Nothing is serving traffic.

What exists:

- **`packages/crypto`** — key hierarchy, sealed-blob format, entry encryption, TOTP. No
  runtime dependencies, 86 tests, 100% line and function coverage, 30 vectors from
  published standards. Unaffected by the move.
- **`services/api`** — registration, login, recovery, session rotation, and the vault
  routes. 48 tests against an in-memory store, so none of them need a cloud account.
  Unaffected by the move except for the storage adapter, which is still to be written.
- **`infra/`** — Terraform for the instance, the NoSQL table, the bucket, the network, and
  the cloud-init that installs Caddy and the service. Written, **not applied**.

What does not exist yet: the NoSQL storage adapter, the HTTP wrapper around the handler,
the client, and the deploy pipeline.

## Next

1. **`store-nosql.ts`** — the `Store` interface is five methods, so this sits beside the
   in-memory implementation rather than replacing anything, and the existing tests stay
   untouched.
2. **`server.ts`** — a Node HTTP server around the existing handler, about thirty lines.
   The handler already takes an event and returns a response.
3. **Apply the infrastructure**, point the DuckDNS record at the instance, and confirm the
   certificate is issued.
4. **The client** — the SPA. The Content-Security-Policy it must satisfy is already in the
   Caddy configuration: no inline script, no eval, and `img-src` with no remote hosts, so
   site favicons cannot be fetched from a third party.
5. **Deploy pipeline** — build, ship to the host, restart the service.
6. **Backups and monitoring** — scheduled encrypted export to Object Storage, and whatever
   alerting is worth having on one host.

Later, once the vault is stable: the marketing site and the Android client. The Android
client asserts against the same vector files `packages/crypto` does, which is why those
exist before it is written.

## Open questions

- **Is the tenancy Always Free or Pay As You Go?** A console check. Idle reclamation
  applies only to always-free-only accounts, and it is the single most likely thing to
  take this service down. See [docs/runbook.md](docs/runbook.md).
- **Does the instance hold above 20% memory on its own?** If it does, no keep-warm loop is
  needed. Worth several days of measurement before burning a core to satisfy a policy.
- **Argon2id instead of PBKDF2.** Deferred rather than rejected; see
  [decisions/0001](decisions/0001-cryptography-and-key-hierarchy.md).
- **Buy a domain?** Roughly ₹800 a year, and it removes the largest accepted risk in the
  threat model. Declined for now, deliberately.

## Recently done

**2026-09-22 — Moved to OCI, and consolidated everything into this repository.** The AWS
deployment was built, applied, and verified, and then could not be reached: the account
refused Function URL invocation from CloudFront and from public callers alike, while
permitting it for an IAM identity. Six variants were tried before concluding the cause was
account-level. [decisions/0003](decisions/0003-running-everything-on-oci.md) has the full
account. The AWS resources are still standing and need removing.

**2026-09-22 — `services/api` written.** Tested against an in-memory store.

**2026-09-22 — `packages/crypto` written.** Vectors from published standards, cross-checked
against two independent implementations before being committed.

**2026-09-22 — Repository created; cryptography, storage, and threat model decided.**
Started from an empty directory rather than porting the previous implementation, which
claimed zero-knowledge but transmitted the master password to the server.
