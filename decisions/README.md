# Decisions

One file per decision that was not obvious, recording what was chosen, what was rejected,
and why. Written so that a reader arriving later — including a future AI session — can
tell whether a decision still holds, instead of guessing at the reasoning and repeating
the analysis.

A record belongs here when the reasoning is not recoverable from the code. "We use Oracle
NoSQL" is visible in the Terraform; *why the capacity mode may never change* is not.

## Format

Title, status, date, then: Context, Decision, Rejected, Consequences.

**Rejected** carries most of the value. It is what stops an option from being
reconsidered from scratch every few months, and what explains an unusual choice to
someone who would otherwise assume it was an oversight.

## Index

| # | Decision |
|---|---|
| [0001](0001-cryptography-and-key-hierarchy.md) | Cryptography and key hierarchy |
| [0002](0002-storage-and-data-model.md) | Storage and data model |
| [0003](0003-running-everything-on-oci.md) | Running everything on one provider |
| [0004](0004-the-access-token-header.md) | The access token header |
| [0005](0005-pull-based-releases.md) | Releases are pulled by the host |
| [0006](0006-admin-panel.md) | An admin panel that cannot read the vault |
| [0007](0007-roles-and-site-editing.md) | Staff roles, and a website edited from the admin panel |
| [0008](0008-release-pipeline.md) | Releases are published by CI on every merge to main |
| [0009](0009-identity-keys-and-sharing.md) | Identity keys, and the shape sharing will take |
| [0010](0010-self-hosted-product.md) | Vault is a product customers run on their own servers |
| [0011](0011-two-factor-sign-in.md) | Two-factor sign-in |
| [0012](0012-storage-drivers-and-migrations.md) | SQLite, PostgreSQL and MySQL, and versioned schema migrations |
| [0013](0013-distribution-and-releases.md) | One image, two install profiles, generated secrets, setup link, signed releases |
| [0014](0014-service-desk.md) | The built-in service desk: access requests, sign-in help, support |
| [0015](0015-organizations-and-collections.md) | Organizations and collections as built: org key, invitations by digest, confirmation, key versions |
| [0016](0016-teams-completion.md) | Key rotation, groups, policies, access audit, emergency access, operator view |
| [0017](0017-personal-backups.md) | Personal backups: each person's own schedule and destination (S3, WebDAV, on the server) |
| [0018](0018-share-links.md) | Share links: one item, opened without an account; the key stays in the link |
| [0019](0019-breach-check.md) | Breach check: k-anonymity, relayed by the server, on request |
| [0020](0020-attachments-and-offline-copy.md) | File attachments with a key per file; an offline copy in one HTML file |
| [0021](0021-sso.md) | Single sign-on (OIDC) for sign-in; the master password still unlocks |
| [0022](0022-passkeys.md) | WebAuthn second factor; unlock with a passkey (built in 0034); storing passkeys (built in 0035) |
| [0023](0023-crypto-hardening.md) | Signed key grants, an opt-in secret key, Argon2id, an organization recovery key |
| [0024](0024-cloud-drive-backups.md) | Google Drive and OneDrive backups via operator-registered OAuth apps, narrowest scopes |
| [0025](0025-signed-key-grants.md) | Signed key grants: a signing key per account, grants signed by admins, members verify (closes A15) |
| [0026](0026-organization-recovery-key.md) | Organization recovery key: org key escrowed to a key the owner keeps offline |
| [0027](0027-secret-key.md) | Opt-in secret key mixed into key derivation, with an Emergency Kit |
| [0028](0028-argon2id.md) | Argon2id (64 MiB, t=3) in our own WebAssembly; new accounts, password changes and a one-click upgrade |
| [0029](0029-browser-extension.md) | The browser extension: fill on request, matched by origin, keys in session memory |
| [0030](0030-editions.md) | Three editions from one codebase: personal, business, hosted |
| [0031](0031-two-workspaces.md) | Two workspaces: My vault and the Admin console |
| [0032](0032-business-edition.md) | The business edition: one company, People, permission sets, team health, guests |
| [0033](0033-hosted-edition.md) | The hosted edition: companies as tenants, invited by the operator |
| [0034](0034-passkey-unlock.md) | Unlock with a passkey: PRF wraps the vault key in the browser; discoverable, user-verified, no second factor needed |
| [0035](0035-passkeys-in-the-extension.md) | Passkeys for other sites kept in Vault, answered by the extension; origin from the browser, rpId checked, the person confirms |
| [0036](0036-account-then-master-password.md) | Sign in to the account (account password, two-factor), then unlock with the master password; both checked by the server |
| [0037](0037-account-first.md) | An account first (email code), a vault later (open, invitation or approved request); the email address is the username |
| [0038](0038-several-vaults.md) | Several vaults in one account: Personal is the account key; others have their own keys wrapped under it; the server sees an opaque vault id per entry |

## A note on the numbering

This set was renumbered once, on 2026-09-22, when the platform changed from AWS to OCI.
Ordinarily a decision that stops being true is superseded by a new one that references it,
and the original stays — the reasoning that led to a wrong answer is worth keeping.

That was not the right thing to do here. The AWS version of this project was built and
applied but never served a request, and half the records described a system that had
stopped existing. Keeping four superseded records about a dead architecture would have
buried the four that describe the live one. [0003](0003-running-everything-on-oci.md)
carries the full account of what was tried on AWS and why it was abandoned, which is the
part worth keeping.

Numbers are stable from here.
