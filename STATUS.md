# Status

What is in flight. Updated when something starts, stalls, or finishes.

Last updated: 2026-09-22

## Right now

**The vault is serving at https://vault-shivam.duckdns.org.** One always-free OCI
instance running Caddy and the API, with MySQL HeatWave behind it. Nothing else is
involved — no AWS, no CDN, no second provider.

Verified against the running system rather than the plan:

- Let's Encrypt certificate, issued unattended. HTTP redirects to HTTPS.
- TLS 1.0 and 1.1 refused, 1.2 and 1.3 accepted.
- Every security header the threat model asks for, `server` suppressed.
- `/api/health` answers through Caddy from outside. `/api/auth/prelogin` returns a decoy
  salt that is stable for one address and different between addresses.
  `/api/auth/register` is 403, because registration is closed. `/api/nope` is a real 404
  rather than the SPA shell.
- The database is reachable only from inside this project's VCN, and holds the schema the
  service created for itself on first start.
- SSH has no ingress rule.

What does not exist yet: the client, and a deploy that does not need inbound SSH.

## What it took to get here

Nine faults, none of which a plan or a validate would have caught. They are listed because
each one produced a symptom that pointed somewhere else:

| Symptom | Actual cause |
|---|---|
| `ufw status` says 80 is open; the port is closed | OCI's image REJECTs ahead of ufw's chains |
| `caddy.service: status=217/USER` | cloud-init wrote a conffile before the package installed, dpkg prompted, the package never configured, its user was never created |
| A healthy server showing "Caddy works!" with no certificate | the package started Caddy first, and `enable --now` does nothing to a running service |
| `status=5/TRAP` in V8 | `MemoryDenyWriteExecute=true`, which forbids exactly what a JIT needs |
| `connect ETIMEDOUT` to the database | the subnet's default security list has no 3306 rule; NSGs do not cover a managed MySQL |
| `Unknown database 'vault'` | a managed MySQL ships a server and an admin user, not a schema |
| A permission warning about the expiry event on every start | the scheduler was already on; only the redundant `SET GLOBAL` failed |
| Terraform wanting to replace the database forever | `admin_password` and `admin_username` are write-only and never read back |
| Terraform creating a second database | an apply died between creating it and saving state, leaving a deleted one in state |

## Next

1. **The client.** The Content-Security-Policy it must satisfy is already live and can be
   read off a response: no inline script, no eval, and `img-src` with no remote hosts, so
   site favicons cannot be fetched from a third party.
2. **A deploy that needs no inbound SSH.** Today `scripts/deploy.sh` needs port 22 opened
   and closed around it, which is friction on every deploy and a standing decision to get
   wrong. The shape that fits: CI uploads a bundle to Object Storage, and the host pulls
   it. Nothing inbound at all.
3. **The scheduled export to Object Storage.** The always-free tier refuses a managed
   backup policy, so this is not a second line of defence — it is the only one, and it
   does not exist yet.
4. **The first account**, once the client can create one: open registration, register,
   write the recovery key down, close registration.

Later: the marketing site and the Android client.

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
