# Security policy

Vault is a password manager; its users trust it with everything. Reports are welcome and
taken seriously.

## Reporting a vulnerability

Please report privately — not in a public issue:

- **GitHub:** *Security → Report a vulnerability* on this repository (private advisory), or
- **Email:** developer.shivamsharma@gmail.com, subject starting `[vault security]`.

Include what you found, how to reproduce it, and what an attacker gains. You will get an
acknowledgement within three working days and a plan within ten. Please give a reasonable
time to fix before publishing; you will be credited unless you prefer otherwise.

## Scope

In scope: the cryptography (`packages/crypto`), the API, the web client, the container image
and install profiles, and the release pipeline. The design and its accepted risks are in
[docs/threat-model.md](docs/threat-model.md) and [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md) —
a report showing an accepted risk is worse than stated there is still very welcome.

Out of scope: the reference instance's free dynamic-DNS name (accepted risk A3), denial of
service by volume, and findings that need a compromised device or browser.

## Supported versions

The latest release. Fixes are released as a new version; self-hosted installs upgrade by
pulling it (see [docs/INSTALL.md](docs/INSTALL.md#upgrading)).

## Verifying a release

Images are signed with Sigstore by the release workflow's own identity, and carry an SBOM and
build provenance. See [docs/INSTALL.md](docs/INSTALL.md#verifying-the-image).
