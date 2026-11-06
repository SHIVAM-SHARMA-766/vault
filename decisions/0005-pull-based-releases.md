# 0005 — Releases are pulled by the host

Status: Accepted
Date: 2026-11-06

## Context

Until now every deploy went through `scripts/deploy.sh`, which copies files to the host
over SSH. The host has no SSH ingress rule by default, so each deploy meant opening port 22
for one address with Terraform, deploying, and closing it again. That friction was
deliberate, but it made every code change a change to the network, and a forgotten close
leaves SSH open on the host that serves a password manager.

The alternatives considered:

- **Serve the client straight from Object Storage.** OCI Object Storage can set only
  `Content-Disposition` and `Cache-Control` on a response, so it cannot carry the
  Content-Security-Policy the client depends on ([0003](0003-running-everything-on-oci.md)).
- **Have Caddy proxy every request to the bucket**, through a pre-authenticated request
  URL. This works and keeps the headers, but each page view costs Object Storage requests
  against a 50,000-a-month always-free allowance shared by the whole tenancy. A public
  website with a few thousand visitors, or one crawler, would use it up. It also makes the
  site depend on the bucket for every request, and puts a long-lived secret URL in the
  Caddy configuration.
- **A CDN in front** (CloudFront with a private S3 origin). Declined: the operator chose to
  stay on one provider, and a free DuckDNS name cannot be pointed at a CDN anyway.

## Decision

**A release is a tarball in a private `vault-releases` bucket. The host fetches it on a
timer, checks it, installs it, proves it works, and rolls back if it does not.**

```
operator ── scripts/release.sh ──► vault-releases bucket
                                     releases/<id>.tar.gz
                                     releases/<id>.tar.gz.sha256
                                     current            "<id> <sha256>"
                                          ▲
                                          │ read-only, as the instance, every 5 minutes
                                          │
host: vault-pull.timer ── vault-pull.sh ─┘
        ├─ verify the tarball against the hash in `current`
        ├─ verify every file against the MANIFEST inside it
        ├─ caddy validate the release's Caddyfile
        ├─ install web/, api/, Caddyfile; restart vault-api; reload Caddy if changed
        ├─ check /api/health, then /, /app/, /security through Caddy and TLS
        └─ on failure: reinstall the previous release, mark this one failed
```

- **Release ids name a commit:** `20261106T124831Z-b4003c039356`. `release.sh` refuses to
  publish from a dirty tree, so anything live maps to source. The id is also served at
  `/release.txt`, which is how `release.sh` knows the host has picked it up.
- **The host reads the bucket and cannot write it.** Writing is left to the operator's own
  OCI user. A compromised host therefore cannot plant a release that survives a rebuild.
- **Order of upload:** the tarball and its hash first, `current` last, so the host never
  sees a pointer to something that is not there yet.
- **A failed release is not retried** every five minutes. Publishing a new one is how to
  move on; `release.sh --rollback <id>` points `current` at an earlier one.
- **Requests:** one `GET current` every five minutes is under 9,000 a month, plus the
  occasional tarball. Well inside the allowance alongside the daily backup.

`scripts/deploy.sh` remains, with a narrower job: setting up the host itself — the systemd
units, the backup timer, the pull timer, and its configuration in `/etc/vault/release.env`.
That still needs SSH, which is now a rare event rather than part of every change.

## Consequences

**Write access to the releases bucket is as powerful as control of the hostname.** Whoever
can write there chooses the JavaScript the browser runs, which sees the master password.
This is the same position as threat A3, and it is now a second way into it. The control is
IAM: only the operator's user can write. The SHA-256 checks catch corruption and
half-finished uploads; they do not stop someone who can write the bucket, because that
person can write the hash too. Signing releases with a key the host trusts would close that
gap and is the next step if more than one person ever holds write access.

**Deploys take up to five minutes to go live.** `release.sh` waits and reports when
`/release.txt` shows the new id.

**The host must reach Object Storage.** If it cannot, nothing new installs, and the site
keeps serving the release already on disk. Losing the bucket stops deploys, not the site.

**The first install on a new host has nothing to roll back to.** `deploy.sh` runs the pull
once while SSH is open, so a failure there is seen and fixed in the same session.
