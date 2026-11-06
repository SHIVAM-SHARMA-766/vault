# 0010 — Vault is a product customers run on their own servers

Status: Accepted
Date: 2026-11-06

## Context

The business model is self-hosting: an organization installs Vault on infrastructure it
controls and runs it for its own people. This is the Bitwarden self-hosted model, not the
1Password model, where the vendor operates the service for everyone.

Everything built so far assumed one deployment — this project's own, on OCI, behind a DuckDNS
name — and was shaped by it: OCI instance principals for backups, an OCI bucket for releases,
Caddy configured by our scripts, the first account bootstrapped over SSH.

## Decision

**The deliverable is an installable, upgradable, signed package. The OCI deployment becomes
the reference instance and demo, run with the same package customers get.**

What that commits the product to:

- **Configuration, not code, describes a deployment.** Hostname, database, backup target,
  mail server and owner are settings. Nothing in the product names DuckDNS, OCI, a region or an
  address.
- **A standard way to run it.** A container image and a Compose file (app, database, reverse
  proxy) is the supported install; a plain tarball with systemd units remains for those who
  want it. Kubernetes comes when a customer asks.
- **First-run setup in the product.** The first person to open a fresh install, holding a
  one-time setup token printed in the server log, creates the owner account. No SSH, no
  environment-variable toggles.
- **Pluggable storage and backups.** MySQL today; PostgreSQL next, because most self-hosters
  run it; SQLite for single-server installs. Backups to local disk or any S3-compatible store,
  not only OCI Object Storage.
- **Upgrades are safe and boring.** Versioned schema migrations, run on start, tested from
  every supported prior version; a release never requires a manual database step.
- **Mail.** Invitations, new-device alerts and security notices go through the customer's SMTP
  server. Nothing is sent through ours.
- **No phoning home.** No telemetry, no licence server the install must reach. If licences
  exist, they are verified offline.

## Consequences

**The vendor's release is now the trust path.** On a customer's install, their own domain
replaces DuckDNS as threat A3 — that part gets better. But every customer runs code we build,
so our build and release process becomes what an attacker would target to reach all of them at
once. That moves to the front:

- releases signed with a key CI does not hold in plain form, and verified by the installer and
  by the update path;
- a software bill of materials with every release;
- reproducible builds, so a customer can check an image matches the source;
- a published security policy and a way to report vulnerabilities.

**Some of today's design is specific to our instance and stays there:** the OCI bucket release
channel and pull agent ([0005](0005-pull-based-releases.md)), the CI identity
([0008](0008-release-pipeline.md)), and `scripts/deploy.sh`. They keep running the reference
instance; customers upgrade by pulling a new signed image.

**The admin panel's "owner" splits in two.** On a customer install the owner is their
administrator. Operating the product for many customers is not something the product does,
because there is no central service.

**Identity keys and the sharing model are unaffected** ([0009](0009-identity-keys-and-sharing.md));
they were designed without assuming who runs the server.

**Open business decisions**, recorded in the roadmap: the licence (open source such as AGPL,
source-available, or proprietary with offline licence keys), pricing (per user, per server),
and how customers receive updates (public registry, or a private one they authenticate to).
