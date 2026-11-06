# Status

What is in flight. Updated when something starts, stalls, or finishes.

Last updated: 2026-11-06

## Right now

**The client is live at https://vault-shivam.duckdns.org.** Registration, unlock, and
entry CRUD, served from the same origin as the API by Caddy on one always-free OCI
instance, with MySQL HeatWave behind it.

The whole product is now in one repository: cryptography, API, client, infrastructure,
deploy scripts, decisions, and runbook.

Verified from outside, against the running system:

- Missing assets return 404; client-side routes return the shell. Getting that boundary
  wrong turns a mistyped script URL into HTML with status 200 and a confusing parse
  error.
- The shell is `no-store` and hashed assets are immutable for a year. A cached shell
  after a deploy points at assets that no longer exist, and the page is blank with
  nothing in the console.
- Eight security headers, `server` suppressed, TLS 1.0 and 1.1 refused.
- SSH is unreachable — verified by a connection attempt rather than a port probe.

**The build is checked against the policy it is served under.** A Content-Security-Policy
violation does not fail a build; it produces a blank page and a console message nobody
sees during a deploy. `apps/web/scripts/check-csp.mjs` asserts there is no inline script,
no inline style, no `eval`, and no remote URL, and it runs as part of `npm run build`.

## What it took

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

1. **A deploy that needs no inbound SSH.** Today `scripts/deploy.sh` needs port 22 opened
   and closed around it, which is friction on every deploy and a standing decision to get
   wrong. The shape that fits: CI uploads a bundle to Object Storage, and the host pulls
   it. Nothing inbound at all.
2. **The first account**: open registration, register, write the recovery key down, close
   registration. The daily exports are ~1.5 KB, which says the table is still empty.
3. **`prevent_destroy` on the MySQL DB system.** The NoSQL table it replaced had it; the
   database does not, so a stray `terraform destroy` deletes the vault.
4. **Remove the AWS resources** left standing from the first deployment.

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

**2026-11-06 — Client redesigned.** Split sign-in screen, three-pane vault (filters, list,
detail) with search, favourites, copy with a 30-second clipboard clear, live TOTP codes, a
password generator and strength meter, delete confirmation, and light and dark themes that
follow the system. Collapses to two panes on tablets and one on phones. Still no inline
style, no remote asset, and no favicon fetch, so it runs under the same policy.

**2026-09-24 — Client live, and the daily export running.** Exports land in `vault-backups`
every day; a restore was tested on 2026-09-24.

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
