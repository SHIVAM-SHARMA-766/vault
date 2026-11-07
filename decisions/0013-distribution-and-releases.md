# 0013 — Distribution: one image, two profiles, signed releases

Status: Accepted
Date: 2026-11-07

## Context

Phase 2 makes Vault something anyone installs ([0010](0010-self-hosted-product.md)). The
reference instance is assembled by hand on OCI — Caddy serving files, systemd units, a pull
agent — which no customer should have to reproduce. The question is what a customer
receives, how it is configured, how it is kept, and how they know it is ours.

## Decision

1. **One container image** holds everything: the API, the web client and the website, served
   by one Node process (`SERVE_STATIC=true`) with the same headers and caching rules as the
   reference Caddyfile (`services/api/src/web.ts`, kept identical by a test). It runs as a
   non-root user, keeps all state in `/data`, and defaults to SQLite.
2. **Two Compose profiles** (`deploy/`): *personal* (Vault + Caddy) and *business* (Vault +
   PostgreSQL + Caddy). Caddy is there only for TLS, which Vault cannot work without.
3. **Zero manual secrets.** On first start the server generates its pepper and token key into
   `/data/secrets.env` (mode 0600). A one-time **setup link** in the log creates the owner
   account, replacing `ADMIN_EMAILS` and `ALLOW_REGISTRATION` for customers.
4. **Backups are part of the product**, not of the host: one encrypted file per backup with
   every row and the server secrets, to disk and/or any S3-compatible store; a file and its
   passphrase restore onto any driver. CI restores one into a fresh container on every change.
5. **Releases are tagged by the maintainer** and published by a workflow that builds amd64 and
   arm64 images, attaches an SBOM and SLSA provenance, and signs with Sigstore **keyless**
   signing — the workflow's OIDC identity, so no long-lived signing key exists in CI or
   anywhere else to steal.
6. **Upgrades are tested**: databases at every earlier schema version migrate to the latest
   (unit test), and CI starts the base branch's image, then the new one, on the same volume.

## Consequences

- The reference instance keeps its own path (Caddy + systemd + pull releases, decision
  [0005](0005-pull-based-releases.md)); the image is not yet what runs it. Moving it onto the
  image is possible later and would make the reference instance exactly what customers run.
- **Still open, and the operator's to decide:** the **update channel** (the workflow pushes
  to GHCR, which is private while the repository is), the **licence**, and **pricing**. Until
  the channel is decided, installs build the image from source, which the profiles do by
  default.
- The release pipeline's trust root is the GitHub repository and its tag-push permission;
  [threat model](../docs/threat-model.md) A12 covers it.
