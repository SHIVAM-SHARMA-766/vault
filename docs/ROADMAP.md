# Roadmap

Where Vault is going, in what order, what is finished and what is left. Written for the
people building it and for an AI assistant picking up the work cold, so it says why as well
as what.

| Document | Role |
|---|---|
| **This page** | The plan, and progress against it |
| [STATUS.md](../STATUS.md) | The running log: what changed, when, and what it took |
| [KNOWN-ISSUES.md](KNOWN-ISSUES.md) | Limits and accepted risks of what exists today |
| [`decisions/`](../decisions/) | Why things are the way they are |

Last revised: 2026-11-07

## At a glance

```mermaid
flowchart LR
  p0["Phase 0<br/>Foundation<br/>✅ done"]:::done --> p1["Phase 1<br/>Complete personal vault<br/>🟡 code done · 4 ops items left"]:::now
  p1 --> p2["Phase 2<br/>Self-hosted product<br/>⬜ next"]:::next
  p2 --> p3["Phase 3<br/>Teams"]:::later
  p3 --> p4["Phase 4<br/>Browser extension"]:::later
  p4 --> p5["Phase 5<br/>Android"]:::later
  p5 --> p6["Phase 6<br/>Enterprise"]:::later
  classDef done fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef now fill:#fef9c3,stroke:#ca8a04,color:#713f12
  classDef next fill:#e0e7ff,stroke:#4f46e5,color:#1e1b4b
  classDef later fill:#f3f4f6,stroke:#9ca3af,color:#374151
```

| Phase | Goal | State |
|---|---|---|
| 0 — Foundation | Keys for sharing, local stack, browser tests, release pipeline | ✅ Done 2026-11-06 |
| 1 — Complete personal vault | Everything one person needs, hardened and monitored | 🟡 All code merged-ready (PR #19); 4 operator items left |
| 2 — Self-hosted product | Anyone installs and upgrades it with one command | ⬜ Next |
| 3 — Teams | Organizations, shared collections, policies | ⬜ Planned |
| 4 — Browser extension | Autofill, the main way a password manager is used | ⬜ Planned |
| 5 — Android | Autofill and biometric unlock on the phone | ⬜ Planned |
| 6 — Enterprise | SSO, SCIM, HA | ⬜ Planned |

## The target

**A zero-knowledge password manager that anyone runs on their own server** — one person on a
home server, a family, or a company with hundreds of people
([0010](../decisions/0010-self-hosted-product.md)). It does the job Zoho Vault, 1Password and
Bitwarden do, for personal and business use alike, delivered the way Bitwarden's self-hosted
edition is: a signed package the
customer installs and upgrades, with no central service and nothing phoning home. Two things
are not negotiable: the server never holds anything readable, including who you are
(addresses are keyed hashes) and what you store (names, URLs and tags are encrypted too); and
the customer never depends on us to keep running.

This project's own deployment on OCI is the reference instance and demo, run with the same
package customers get.

**One product, every size.** Personal and business are not separate editions: the same
package runs a single person's vault on a Raspberry Pi and a company's on a cluster. Every
member of a team keeps their own private vault, a single person never has to create an
organization, and features scale up rather than branch.

The first client after the web app is a **browser extension**, because that is where a
password manager is actually used — and because code installed from a package is not served
by the hostname, which closes the largest accepted risk (threat A3) for everyone who uses it.

## Where it stands

| Area | Today |
|---|---|
| Distribution | One hand-built reference instance; not yet installable by a customer (phase 2) |
| Cryptography | PBKDF2 → HKDF key hierarchy, random vault key, recovery key, AES-256-GCM everywhere, identity key pairs (P-256), encrypted export format ([0001](../decisions/0001-cryptography-and-key-hierarchy.md), [0009](../decisions/0009-identity-keys-and-sharing.md)) |
| Vault | Seven entry types with their own fields, nested folders, custom fields, password history with restore, search, favourites, TOTP codes, generator, clipboard clearing, auto-lock, password health, import from nine formats, encrypted and CSV export |
| Account | Change master password, recovery key sign-in and rotation, TOTP two-factor with recovery codes, signed-in devices, security activity |
| Administration | Roles (owner, admin, marketing, viewer), invitations, account management, audit log, website editor ([0006](../decisions/0006-admin-panel.md), [0007](../decisions/0007-roles-and-site-editing.md)) |
| API | Typed error codes, request ids, generated OpenAPI document, one configuration module |
| Delivery | Merge to `main` → CI publishes → host pulls, verifies, rolls back ([0005](../decisions/0005-pull-based-releases.md), [0008](../decisions/0008-release-pipeline.md)) |
| Operations | Health probe and eight OCI alarms, daily verified export, scripted restore drill |
| Quality | 290 unit and API tests, 15 browser tests against the real stack, CI on every change |
| Infrastructure | One always-free OCI instance, MySQL HeatWave (always free), $0 a month |

## How it compares

What a team buyer expects, against what exists. ✓ built · ◐ partly · — not yet. The phase is
where it lands.

| Capability | Zoho Vault | 1Password | Vault | Phase |
|---|---|---|---|---|
| Customer runs it on their own servers | — | — | ◐ one hand-built instance | 2 |
| Signed releases, SBOM, safe upgrades | n/a | n/a | — | 2 |
| Zero-knowledge encryption of passwords | ✓ | ✓ | ✓ | — |
| Names, URLs, tags encrypted too | ◐ | ✓ | ✓ | — |
| Recovery without the server | ◐ | ✓ (Emergency Kit) | ✓ (recovery key) | — |
| Change master password / recovery login in the UI | ✓ | ✓ | ✓ | 1 |
| Folders, password history, custom fields in the UI | ✓ | ✓ | ✓ | 1 |
| Import from other managers, export | ✓ | ✓ | ✓ | 1 |
| Password health (weak, reused, old) | ✓ | ✓ (Watchtower) | ✓ | 1 |
| Breach check without revealing passwords | ◐ | ✓ | — | 1 (decision needed) |
| Two-factor sign-in for the account | ✓ | ✓ | ✓ TOTP | 1 |
| Device and session management | ✓ | ✓ | ✓ | 1 |
| Secret key mixed into the KDF | — | ✓ | — | 1 (decision needed) |
| Organizations, teams, shared collections | ✓ | ✓ | ◐ keys only | 3 |
| Per-collection permissions, hide-password | ✓ | ✓ | — | 3 |
| Organization policies (password strength, 2FA required) | ✓ | ✓ | — | 3 |
| Per-item access audit | ✓ | ✓ | ◐ admin actions only | 3 |
| Emergency / break-glass access | ✓ | ✓ | — | 3 |
| Browser extension with autofill | ✓ | ✓ | — | 4 |
| Passkeys | ◐ | ✓ | — | 4–5 |
| Mobile apps with autofill and biometrics | ✓ | ✓ | — | 5 |
| Offline access | ✓ | ✓ | — | 4–5 |
| SSO (OIDC/SAML), SCIM provisioning | ✓ | ✓ | — | 6 |
| CLI and secrets for developers | ◐ | ✓ | — | 6 |

## Principles every phase keeps

1. **Nothing readable on the server.** A feature that needs the server to see content is
   redesigned or not built. Every feature names, in its decision record, what the server
   learns.
2. **No third parties in the trust path.** No analytics, CDNs, fonts, icon services, or
   external APIs from the client. Where an outside service is unavoidable (breach checks), it
   gets a decision record and a privacy-preserving protocol.
3. **Every new trust boundary enters the threat model** before the feature ships.
4. **Every user-facing flow has a browser test** in `tests/e2e`, and every API route has
   tests for who may and may not call it.
5. **One release path.** Merge to `main`. No hand deploys of code.
6. **Deployment is configuration.** Nothing in the product names a host, provider, region or
   address; this project's own instance is configured like any customer's.
7. **The customer never depends on us at run time.** No telemetry, no licence server, no
   update check they cannot turn off.
8. **$0 for this project's own infrastructure** (the reference instance and the pipeline);
   customers choose and pay for theirs.

## Phases

Each phase has exit criteria. A phase is done when all of them hold, not when its list is
empty.

### Phase 0 — Foundation ✅ (2026-11-06)

- [x] Identity key pairs on every account; the sharing model designed ([0009](../decisions/0009-identity-keys-and-sharing.md))
- [x] One-command local stack (`npm run dev:stack`) and browser tests in CI
- [x] `prevent_destroy` on the database; CI green on a clean checkout
- [x] Release pipeline live (merge → publish → host pulls)

### Phase 1 — A complete, hardened personal vault 🟡

The core every later phase builds on must be finished and trustworthy first.

**Product** — all done

| | Item | Where to see it |
|---|---|---|
| ✅ | Account settings: change master password, rotate recovery key, recovery-key sign-in, identity fingerprint | Settings — [guide](USER-GUIDE.md#account-settings) |
| ✅ | Two-factor sign-in (TOTP) with recovery codes, enforced by the server | Settings → Two-factor |
| ✅ | Signed-in devices: list, name, sign out; security activity | Settings — [guide](USER-GUIDE.md#devices-and-activity) |
| ✅ | Nested folders, every type's own fields, custom fields, password history with restore | Vault — [guide](USER-GUIDE.md#folders-and-history) |
| ✅ | Import (Chrome/Edge/Brave, Firefox, Safari, Bitwarden JSON+CSV, 1Password, LastPass, KeePass, Zoho Vault, any named-column CSV) and export (encrypted, plain CSV behind the master password) | Import & export — [guide](USER-GUIDE.md#import-and-export) |
| ✅ | Password health: weak, reused, old, unencrypted site | Vault → Password health — [guide](USER-GUIDE.md#password-health) |
| ⬜ | WebAuthn / security key as a second factor | Not started; proposed to land with passkeys in phase 4 |

**Platform** — all done

- [x] Client architecture: router, feature modules, shared UI kit
- [x] `packages/core`: item model, search, import/export parsers, password health — no React
- [x] API: request ids in logs, typed error codes, OpenAPI generated from the routes

**Self-host prerequisites** — all done

- [x] One configuration module, no installation-specific defaults ([configuration.md](configuration.md))
- [x] Storage stays behind its interface, enforced by a test

**Operations**

- [x] Monitoring and alerting on the free tier: health probe, eight alarms incl. a heartbeat ([runbook](runbook.md#alerts))
- [x] Restore drill, scripted, with a reminder alarm ([runbook](runbook.md#the-quarterly-restore-drill))
- [ ] **Operator:** `apply.sh`, confirm the alert mail, `deploy.sh`, run the first drill
- [ ] **Operator:** buy a domain and move the reference instance to it (threat A3)

**Exit criteria**

| Criterion | State |
|---|---|
| Every API capability has a UI | ✅ |
| 2FA works end to end | ✅ browser-tested |
| Import from three managers tested with **real** export files | ⬜ tested with fixtures in each published format; real files still needed |
| Alerts reach a phone | ⬜ built; needs the operator steps above |
| The domain is live | ⬜ deferred until bought |

**Decisions this phase still owes** — see [Open decisions](#open-decisions): secret key in the
KDF, breach checks, Argon2id.

### Phase 2 — The self-hosted product ⬜ next

What a customer installs. Built before teams because packaging, configuration and upgrades
touch every part of the system, and are cheaper to get right while it is small.

- [ ] **Two install profiles from one image**:
  - *Personal*: one container with SQLite and built-in TLS — small enough for a Raspberry Pi
    or a free cloud VM, started with one command.
  - *Business*: Compose with PostgreSQL and a reverse proxy, documented for HA in phase 6.
  - A tarball with systemd units as the alternative to containers.
- [ ] **First-run setup**: a one-time token in the server log lets the first visitor create the
  owner. Replaces `ALLOW_REGISTRATION` and `ADMIN_EMAILS` for customers.
- [ ] **Storage**: PostgreSQL alongside MySQL; SQLite for a single server. One store contract test
  suite that every adapter passes.
- [ ] **Schema migrations**: versioned, run on start, tested from every supported version.
- [ ] **Backups**: scheduled encrypted exports to local disk or any S3-compatible store; restore
  documented and tested.
- [ ] **Mail**: the customer's SMTP for invitations and security notices.
- [ ] **Supply chain**: signed images and tarballs (signing key held outside CI in plain form),
  SBOM, reproducible builds, a security policy and disclosure address.
- [ ] **Admin documentation**: install, configure, upgrade, back up, restore, rotate secrets.
- [ ] **Licensing**, once decided: verified offline, never a run-time dependency.

**Exit criteria:** the personal profile runs on a 1 GB ARM board with one command; a fresh VM
goes from nothing to a business install with a TLS domain in under fifteen minutes following
the docs; an install upgrades across three releases without manual
steps; a restore from backup is tested in CI; a tampered image is refused.

### Phase 3 — Teams

The business core. Built on the model in [0009](../decisions/0009-identity-keys-and-sharing.md).

- [ ] Organizations: create, invite members, accept, **confirm by fingerprint**, remove.
- [ ] Collections: create, nest, seal the collection key to members, move items in and out.
- [ ] Permissions per collection: view, edit, manage; can-see-password as a labelled policy.
- [ ] Removal rotates collection keys and re-encrypts.
- [ ] Groups, so collections are granted to teams rather than person by person.
- [ ] Organization policies: minimum master password strength, 2FA required, session length.
- [ ] Access audit: who opened, copied, edited or shared which item — recorded by the server as
  events on ciphertext it cannot read.
- [ ] Emergency access between individuals; organization recovery as an opt-in, visible policy.
- [ ] The admin panel grows from operator tooling into organization administration; the current
  operator roles stay for running the service.

**Exit criteria:** two people in an organization share a collection, one is removed and cannot
read anything added after; every step has browser tests with two browsers; threat A11 is
mitigated by the confirmation step.

### Phase 4 — Browser extension

- [ ] Manifest V3, Chrome and Firefox from one codebase, built from `packages/core` and the
  crypto package.
- [ ] **Points at the customer's server**: the server URL is chosen at first run, and the
  extension's permissions are limited to that origin for API calls.
- [ ] Autofill matched by exact origin and registrable domain (public suffix list bundled, not
  fetched); never fills into a mismatched or cross-origin frame.
- [ ] Save and update on form submit; generator in the page; TOTP fill.
- [ ] Unlock with the master password; keys held in memory with the same idle rules as the web
  client; the extension's own Content-Security-Policy.
- [ ] Talks to the API directly; no page script is ever given the vault key.
- [ ] Passkey storage and use, after autofill is solid.

**Exit criteria:** fills and saves on the top sites in a test matrix; a phishing page on a
look-alike domain gets nothing; published to the Chrome Web Store and Firefox Add-ons.

### Phase 5 — Mobile

Android first (Kotlin), configured with the customer's server URL, using the Android autofill framework; biometric unlock with the vault
key wrapped by a hardware-backed keystore key; an encrypted offline cache. iOS when there is
a reason and a Mac to build on.

**Exit criteria:** cross-implementation crypto tests pass between Android and the web
(including the `pk1` format); autofill works in the top apps in a test matrix.

### Phase 6 — Enterprise

SSO against the customer's identity provider (OIDC first, then SAML) with trusted-device key
handling; SCIM provisioning from their directory; a CLI with secrets injection for developers;
a high-availability reference architecture (several app instances, a replicated database) and
a Helm chart; documented controls customers need for their own audits (access reviews, change
management, incident response).

## Architecture direction

```
packages/crypto   primitives, key hierarchy, identity keys      (no dependencies, ever)
packages/core     item model, search, import/export, health     (no UI)
services/api      HTTP API over one table; storage behind an interface
apps/web          the web client and admin                      (feature modules)
apps/extension    MV3 extension                                 (phase 4)
apps/site         public website, templates + content
android/          Kotlin client                                 (phase 5)
```

Data stays in one table with a partition per owner. Phase 3 adds partitions for organizations
(`ORG#<id>`) holding collections, memberships and sealed collection keys, so an organization's
data is one query, as a user's is today ([0002](../decisions/0002-storage-and-data-model.md)).

The API stays one process behind Caddy until load says otherwise. When a second client
exists, routes move under `/api/v1/` and the old paths remain until the web client has moved.

## Infrastructure: the reference instance, on $0

This section is about this project's own instance and pipeline. Customers size their own.

| Limit | Value | When it bites |
|---|---|---|
| Host | 1/8 OCPU-equivalent, 1 GB RAM (`E2.1.Micro`) | Hundreds of concurrent users, or PBKDF2-heavy endpoints under attack |
| Database | `MySQL.Free`: 50 GB, no managed backups, no HA | Data size is not the issue; recovery time and the lack of point-in-time restore are |
| Object Storage | 20 GB, 50,000 requests a month, shared by backups and releases | More frequent backups or releases than about one every few minutes |
| Availability | One host, one region, idle reclamation possible | Any customer with an uptime requirement |

The reference instance stays on the free tier; a customer's install is sized by the customer,
with guidance in the admin documentation.

## Open decisions

| Decision | Phase | Notes |
|---|---|---|
| Buy a domain | 1 | Planned by the operator. Removes the dynamic-DNS risk (A3). Accepted until then (2026-11-06) |
| Secret key in the KDF | 1 | Strongest protection against offline guessing after a breach |
| Breach checks | 1 | Privacy trade-off; k-anonymity at best |
| Argon2id | 1 | Needs WebAssembly in the crypto package |
| Licence | 2 | Open source (AGPL, as Bitwarden), source-available, or proprietary with offline keys |
| Pricing | 2 | Per user, per server, or support contracts |
| Update channel | 2 | Public registry, or a private one customers authenticate to |
| Supported databases | 2 | PostgreSQL and SQLite alongside MySQL, or fewer |
| Organization recovery | 3 | Opt-in, visible to members, or not offered |
| iOS | 5 | Needs Apple hardware and an account |

## Risks

- **One operator.** Bus factor of one for code, infrastructure and keys. Mitigated by
  documentation written for someone arriving cold, and by recovery that never depends on the
  operator for a user's data.
- **Our release is every customer's trust path.** One compromised build reaches every install.
  Signing, SBOMs and reproducible builds (phase 2) are the answer; until then, `main` and the
  release pipeline are protected by 2FA on the accounts that control them.
- **Browser-delivered code (A3).** On a customer's install their own domain is the trust path;
  on the reference instance it is still DuckDNS until the domain is bought.
- **Self-hosted support load.** Every customer environment differs. A narrow supported path
  (the Compose install) and good diagnostics keep it tractable.
- **Always-free reclamation.** An idle instance can be reclaimed. The data survives in the
  database and exports; the service does not. See the runbook.
- **Cryptographic format is permanent.** Every new ciphertext format is versioned and gets a
  decision record before anything is written in it.
