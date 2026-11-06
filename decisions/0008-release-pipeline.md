# 0008 — Releases are published by CI on every merge to main

Status: Accepted
Date: 2026-11-06

## Context

Since [0005](0005-pull-based-releases.md), shipping code means running `scripts/release.sh`
on the operator's machine with the operator's own OCI credentials. The host pulls the
release; nothing inbound is involved. What remained manual was the publishing step itself:
a person had to remember to run it, from a machine holding an OCI key that can do anything
in the tenancy.

## Decision

**`.github/workflows/release.yml` runs `scripts/release.sh` on every push to `main`, and on
demand from the Actions tab. It publishes as a dedicated OCI user that can write to the
releases bucket and nothing else.**

```
merge to main ──► GitHub Actions: npm ci → release.sh (tests, build, policy checks, upload)
                        │  as vault-ci: manage objects in vault-releases, nothing else
                        ▼
                  vault-releases bucket ──► host's vault-pull timer (unchanged, 0005)
```

- **The same script runs in CI and by hand.** There is one release path; the workflow
  adds credentials and nothing else. `release.sh` still refuses a dirty tree, so every
  release names the commit it was built from.
- **The CI identity is least privilege.** `infra/ci.tf` creates `vault-ci`, a group, and a
  policy allowing `manage objects` and `read buckets` on `vault-releases` only. It cannot
  touch the instance, the database, the backup bucket, or IAM.
- **The private key exists in one place.** `scripts/setup-ci.sh` generates the key pair in a
  private temporary directory, gives Terraform the public half (`infra/ci.pub.pem`,
  committed), sends the private half straight to a GitHub Actions secret, and deletes it
  locally. Running it again rotates the key.
- **CI never reaches the host.** It has no SSH key and no network path in. The host's pull
  agent still verifies, health-checks and rolls back exactly as before.
- **One release at a time.** The workflow's concurrency group queues pushes rather than
  racing the `current` pointer; nothing is cancelled half-uploaded.
- Host set-up (`scripts/deploy.sh`) stays manual. It needs SSH, it is rare, and automating
  it would mean giving CI a way into the host.

## Consequences

**Control of `main` is now control of the code browsers run.** Anyone who can push to
`main` — or who takes over the GitHub account, or can read the repository's Actions secrets
— can publish a release, and a release reaches the page that handles master passwords. This
is the A3 position again, reached through GitHub. The mitigations available on this plan:

- two-factor authentication on the GitHub account, which is now as important as the DuckDNS
  account;
- the repository is private and has one collaborator;
- the CI key can publish releases and do nothing else, so a leak is bounded to that;
- every release is a commit on `main`, so what went live is always in the history.

Branch protection and required reviewers on a deployment environment would add a second
person or an explicit approval, but GitHub offers them on private repositories only on paid
plans. Signing releases with a key the host trusts and that CI does not hold remains the
structural fix, recorded in STATUS.

**Merging is deploying.** Work that is not ready to go live does not belong on `main`.

**The first merge after a unit change needs `deploy.sh` first.** The website editor added
`ReadWritePaths=/srv/vault/site` to `vault-api.service`; a release that depends on it fails
its checks on a host where `deploy.sh` has not been run, the pull agent rolls it back, and
the workflow reports that the release did not go live.

**GitHub Actions minutes.** A release takes a few minutes, most of it waiting for the
host's five-minute timer. A private repository on the free plan has 2,000 minutes a month.
