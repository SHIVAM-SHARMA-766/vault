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

Phase 1 of [ROADMAP.md](ROADMAP.md): a complete, hardened personal vault. In order:

1. ~~Client architecture~~ — done 2026-11-06.
2. ~~Account settings~~ — done 2026-11-06.
3. ~~Two-factor sign-in~~ — done 2026-11-06 (TOTP; WebAuthn next).
4. ~~Folders, entry-type fields, custom fields, password history~~ — done 2026-11-06.
5. ~~Import and export~~ — done 2026-11-06.
6. **Monitoring and alerting**, and the domain.

Then phase 2, the self-hosted product: container image and Compose install, first-run setup,
PostgreSQL, migrations, backups to any S3-compatible store, signed releases.

Carried over: remove the AWS resources (needs new personal AWS keys); sign releases if anyone
else gets write access to `main` or the releases bucket.

## Open questions

- **Is the tenancy Always Free or Pay As You Go?** A console check. Idle reclamation
  applies only to always-free-only accounts, and it is the single most likely thing to
  take this service down. See [docs/runbook.md](docs/runbook.md).
- **Does the instance hold above 20% memory on its own?** If it does, no keep-warm loop is
  needed. Worth several days of measurement before burning a core to satisfy a policy.
- **Argon2id instead of PBKDF2.** Deferred rather than rejected; see
  [decisions/0001](decisions/0001-cryptography-and-key-hierarchy.md).
- **Buy a domain.** Roughly ₹800 a year, and it removes the largest accepted risk in the
  threat model (A3). Re-confirmed 2026-11-06: the risk is accepted until a domain is bought,
  and the public security page says so.

## Recently done

**2026-11-06 — Phase 1, step 5: import and export.** A new Import & export screen
(`/app/import-export`, also in the account menu and the empty vault). Import reads Chrome /
Edge / Brave, Firefox, Safari, Bitwarden (JSON and CSV), 1Password, LastPass, KeePass,
Zoho Vault, our own encrypted export, and other CSVs by column name — parsed in the browser
by `packages/core`, previewed with counts, duplicates (same name, username, site) skipped,
folders recreated or reused, then sealed and sent in batches to a new never-overwrite route
(`POST /api/vault/import`, 100 entries / 50 folders a call). Export is an encrypted file
(own password, PBKDF2 → HKDF → AES-GCM, AAD `vault.export.v1`) by default, and a plain CSV in
Bitwarden's layout behind a local master-password check and an explicit acknowledgement.

**2026-11-06 — Phase 1, step 4: the full entry model.** Nested folders (create, rename,
delete with contents moving up, filter including subfolders); every type has its own fields
from `packages/core`'s item model (card, identity, bank account, SSH key, Wi-Fi, login);
custom fields that can be hidden; every meaningful edit keeps the previous version, sealed
under its own AAD (`vault.history.v1`), viewable and restorable from the entry. Search now
covers visible fields, folder paths and visible custom fields, never secrets.

**2026-11-06 — Phase 1, step 3: two-factor sign-in.** TOTP with ten single-use recovery
codes, enforced by the server after the password at sign-in and at recovery-key sign-in;
replay refused; TOTP keys sealed under the pepper; admin reset with audit; QR code drawn by
`packages/core`, the new shared package, checked against an independent encoder
([0011](decisions/0011-two-factor-sign-in.md)).

**2026-11-06 — Phase 1, steps 1 and 2.** The client is organised as `lib/` (API, session,
router), `ui/` (kit, icons, the shared Shell with an account menu) and `features/` (auth,
vault, admin, settings), with real addresses for every screen and navigation that never
reloads. Account settings: change master password, issue a new recovery key, identity
fingerprint, sign out everywhere; and recovery-key sign-in from the sign-in page, which sets a
new master password. Rotating the recovery key now needs the current password, and a password
can be reset with the recovery key's proof.

**2026-11-06 — Business model decided: self-hosted.** Customers run Vault on their own
servers ([0010](decisions/0010-self-hosted-product.md)); the roadmap now puts the installable,
signed package (phase 2) before teams (phase 3) and the extension (phase 4).

**2026-11-06 — Phase 0, the foundation.** Identity key pairs on every account, with the
sharing model designed ([0009](decisions/0009-identity-keys-and-sharing.md)); a one-command
local stack; browser tests in CI; `prevent_destroy` on the database; [ROADMAP.md](ROADMAP.md)
for teams, with the browser extension as the next client.

**2026-11-06 — Release pipeline.** Every merge to `main` is published by GitHub Actions as
`vault-ci`, an OCI user that can write the releases bucket and nothing else
([0008](decisions/0008-release-pipeline.md)). Needs `scripts/setup-ci.sh` once, and
`deploy.sh` before the first merge that carries the website editor.

**2026-11-06 — Staff roles and website editing.** Owner, admin, marketing and viewer
roles, granted by the owner or carried by an invitation. The public site's text, search
details, images and an announcement banner are edited in the admin panel, drafted,
previewed, published and rolled back without a release
([0007](decisions/0007-roles-and-site-editing.md)). Needs `deploy.sh` before the release
that carries it, for the unit's new `ReadWritePaths=/srv/vault/site`.

**2026-11-06 — Deploys without SSH.** Releases go to a private `vault-releases` bucket and
the host pulls, verifies, installs and health-checks them every five minutes, rolling back
on failure ([0005](decisions/0005-pull-based-releases.md)). `scripts/release.sh` ships code;
`scripts/deploy.sh` now only sets up the host.

**2026-11-06 — Admin panel.** At `/app/admin` for accounts listed in `ADMIN_EMAILS`:
registration mode, single-use invitations, account list with counts, label, sign-out,
disable and delete, last backup, and an audit log. It cannot read a vault or show an
address ([0006](decisions/0006-admin-panel.md)).

**2026-11-06 — Multipage website.** Home, Features, How it works, Security, FAQ and About,
from shared partials, still with no JavaScript and checked for broken links at build.

**2026-11-06 — Public website.** Landing page at `/` and a security page at `/security`, in
`apps/site`: static HTML and CSS with no JavaScript, built and checked against the same
policy as the client. The client moved to `/app/`. `deploy.sh` now stages both into one
tree and validates the Caddyfile on the host before installing it.

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
