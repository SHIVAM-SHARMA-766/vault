# Threat model

This document states what the vault defends against, what it deliberately does not, and
which risks are accepted and why. It is written to be falsifiable: every control names
the threat it addresses, and every gap is listed rather than omitted.

Reviewed whenever the cryptographic design, the storage model, or the hosting
architecture changes. Last reviewed 2026-09-22, against the deployed system rather than the design.

## Assets, in priority order

1. **Vault contents** — credentials, TOTP secrets, notes. Disclosure is unrecoverable:
   the user cannot un-leak a password they reused elsewhere.
2. **Master password** — derives everything. Compromise means total compromise.
3. **Recovery key** — an equal-power alternative to the master password.
4. **Vault Key** — the symmetric key all entries are encrypted under.
5. **Auth Key** — grants API access. Compromise yields ciphertext and the ability to
   destroy data, but not plaintext.
6. **Vault metadata** — entry counts, timestamps. Low value, and partially exposed by
   design.

## Trust boundaries

```
  ┌─ TRUSTED ──────────────────┐
  │  The user's browser tab    │   master password, Master Key, Vault Key,
  │  after unlock              │   decrypted entries — memory only
  └────────────┬───────────────┘
               │  HTTPS, ciphertext + Auth Key only
  ┌────────────▼───────────────┐
  │  UNTRUSTED                 │   the host, Caddy, the API process,
  │  All server infrastructure │   MySQL, Object Storage, cloud
  └────────────────────────────┘   operators, backups
```

The design assumption is that everything below the boundary is hostile. A full compromise
of the host and the cloud tenancy should yield ciphertext and nothing else.

## Adversaries and what stops them

### A1 — Network attacker on the path

Reads or modifies traffic between browser and server.

Stopped by TLS everywhere, HSTS with a long max-age, and the fact that plaintext never
crosses the boundary in the first place. Caddy obtains and renews the certificate itself
and redirects plain HTTP; port 80 exists only so the certificate can be issued.

The TLS floor is whatever Caddy negotiates, which is 1.2 and above — unlike the previous
deployment, where the platform's default certificate fixed it at 1.0. This is one of the
few things the move to a single host improved.

Modification of the *application* is the more serious version of this threat, and on this
deployment it has a specific shape — see A3.

### A2 — Database or backup disclosure

Obtains a dump of the MySQL table or an export from Object Storage.

Every entry field is AES-256-GCM ciphertext under a key derived from a password the
server has never seen ([0001](../decisions/0001-cryptography-and-key-hierarchy.md)). Email
addresses are HMAC'd under a pepper held outside the table, so the dump does not identify
whose accounts these are. Backups are exports of already-encrypted data and need no
separate protection.

Offline guessing against the wrapped Vault Key is bounded by PBKDF2 at 600,000
iterations — tractable only against a weak master password, which is why a strength floor
is enforced at signup.

### A3 — Malicious or modified application code

The highest-severity threat in any browser-delivered encryption product, and the one that
bypasses everything above. An attacker who can alter the JavaScript the browser executes
can exfiltrate the master password directly, and every other control becomes irrelevant.

Controls:

- HTTPS only. Caddy redirects plain HTTP and serves nothing over it.
- A strict Content-Security-Policy with no `unsafe-inline` and no `unsafe-eval`,
  restricting `connect-src` to `'self'` so that injected code cannot exfiltrate to an
  arbitrary host. The client and the API share an origin precisely so this can be said.
- `img-src` names no remote host. Fetching site favicons from a third party would tell
  that third party which services the vault holds accounts for, which is most of what the
  encryption protects.
- Subresource Integrity on built assets.
- A deliberately small dependency tree, and zero third-party dependencies in the
  cryptographic package, so a compromised transitive package cannot reach key material.
- The service runs unprivileged under systemd with `ProtectSystem=strict`, so a flaw in
  the API cannot rewrite the files Caddy serves.

**The unmitigated part, stated plainly.** The hostname is a free dynamic-DNS name. Whoever
controls that name — the dynamic-DNS operator, or anyone who takes over the account at it
— can point it at their own server, obtain a valid certificate for it from any public CA,
and serve whatever JavaScript they like. None of the controls above apply, because the
browser is talking to them, legitimately, over a valid certificate.

That is materially worse than a compromise of this server, which yields only ciphertext
and auth keys. Here the attacker gets the master password and therefore the vault.

**A second way into the same position: the releases bucket.** Since
[0005](../decisions/0005-pull-based-releases.md) the host installs whatever the
`vault-releases` bucket's `current` object points at. Whoever can write that bucket chooses
the code browsers run. The host itself can only read it; write access belongs to the
operator's OCI user alone, and that user's API key is therefore as sensitive as the DuckDNS
account. The SHA-256 manifest guards against corruption, not against a writer.

**And a third: `main`.** Since [0008](../decisions/0008-release-pipeline.md) every push to
`main` is published by GitHub Actions as `vault-ci`, which can write the releases bucket.
Whoever can push to `main`, take over the GitHub account, or read the repository's Actions
secrets can therefore publish code. Two-factor authentication on GitHub carries the same
weight as on DuckDNS; the CI key is limited to that one bucket, so a leak of it is bounded to
publishing a release.

This is accepted knowingly. It is the reason
[0003](../decisions/0003-running-everything-on-oci.md) keeps buying a domain on the table
as the cheapest available security improvement, and it is the strongest argument for the
native Android client, which is not delivered over the web at all.

### A4 — Compromised server

Code execution on the instance, or a stolen cloud credential.

Yields ciphertext, the ability to delete data, and the Auth Key of anyone who logs in
during the compromise. It does not yield plaintext: the Master Key is never transmitted,
and the Auth Key is a separate HKDF branch that cannot be worked backwards to it.

Bounded further by least privilege: the instance authenticates as itself through a dynamic
group that matches one OCID, and its policy names the backup bucket and, read-only, the
releases bucket — so a compromised host cannot plant a release that outlives a rebuild. It cannot
reach anything else in the tenancy — including the automation runner that shares the
account. Exports to Object Storage let the vault be rebuilt after destructive action.

### A9 — Compromised admin account

An attacker who signs in as an account listed in `ADMIN_EMAILS`.

Can open registration, issue invitations, disable or delete accounts, and sign them out.
Cannot read a vault, see an address, or reset a master password: the admin panel is limited
to what the server already holds, which is ciphertext and metadata
([0006](../decisions/0006-admin-panel.md)). Every action is in the audit log, written before
the action runs.

Controls: admin is decided by configuration on the host, not by anything in the database,
so a database write cannot create an admin. The account is protected by the same
zero-knowledge sign-in and per-address, per-IP limits as any other, plus a separate admin
rate limit. Deletion requires the target's id as confirmation, and the admin cannot disable
or delete their own account. The daily export is the recovery path from destructive use.

**Since [0007](../decisions/0007-roles-and-site-editing.md) there are lesser staff roles.**
An *admin* can do the above to accounts ranked below it, but cannot grant roles or touch
another admin or an owner. A *viewer* can read the panel and change nothing. A *marketing*
account can edit and publish the public website — and only that.

### A10 — Hostile website content

An attacker who controls a marketing account (or any role that can publish the website), or
who can write the content rows directly.

The site shares an origin with the vault client, so script on the site could read the master
password as it is typed. That is the outcome to prevent, and it is prevented in the renderer
rather than by trusting editors: every value is HTML-escaped, there is no field that accepts
markup, links are limited to site paths and `https://`, icons are from a fixed set, and
uploaded images must be PNG, JPEG or WebP by their bytes — SVG is refused. The
Content-Security-Policy, which allows no inline script, is the second layer. The security
page's text is not editable.

What remains is defacement: misleading text or images on the public site. It is audited,
and any earlier version can be made live again in one click.

### A12 — A compromised release (the vendor's supply chain)

Vault is installed and run by customers on their own servers
([0010](../decisions/0010-self-hosted-product.md)). Every install runs code this project
builds, so an attacker who can alter a release — through the repository, the CI pipeline, a
dependency, or the registry it is published to — reaches every customer at once, and a
modified client sees master passwords.

Controls today: CI builds from `main` with a committed lockfile (`npm ci`), a dependency audit
on every change, and a crypto package with no dependencies at all. Planned for phase 2 and
required before the first customer install: signed releases verified by the installer and the
update path, an SBOM per release, reproducible builds, and a published disclosure policy.

### A11 — Public-key substitution (applies once sharing exists)

The server hands out identity public keys ([0009](../decisions/0009-identity-keys-and-sharing.md)).
A hostile server could hand out a key it controls in place of a colleague's, and receive
whatever is shared to "them". Nothing is shared today, so this does not yet apply.

Controls, designed for phase 3 (teams): a public key cannot be replaced once set (enforced now); a
member joining an organization is sealed to only after an admin confirms their fingerprint;
fingerprints are shown to both people so they can be compared out of band.

**Account changes need the password, not just a session.** Changing the master password
and issuing a new recovery key both require proof of the current master password (or, for a
password reset, of the recovery key), checked by the server. A stolen access token can read
ciphertext for fifteen minutes; it cannot take the account's ways back in away from its owner.

### A5 — Stolen or shared device

Physical access to an unlocked session.

Keys live in memory only and are discarded on logout, tab close, and idle timeout. Nothing
sensitive is written to `localStorage`, `sessionStorage`, or IndexedDB. The consequence is
that a page reload requires re-entering the master password, which is a deliberate trade
against convenience.

Import and export put plaintext on disk only when the user asks for it. Files picked for
import are read in memory and never uploaded as they are. The encrypted export is the
default; the plain CSV needs the master password (checked locally, by unwrapping the Vault
Key) and an explicit acknowledgement, and both screens tell the user to delete the file.
What happens to a downloaded file afterwards is outside Vault's control.

### A6 — Credential stuffing and brute force

**With two-factor sign-in on** ([0011](../decisions/0011-two-factor-sign-in.md)), a correct
master password alone yields no wrapped vault key and no session; a code from the user's
authenticator (or a single-use recovery code) is also required, and each code works once.
The TOTP keys and recovery-code hashes are sealed under the pepper, outside the database's
reach.


Online guessing against the login endpoint.

Rate limiting per address and per IP, exponential lockout after repeated failures, and
scrypt on the server so that each guess costs the attacker real work. The Auth Key sent
by the client is already the output of 600,000 PBKDF2 iterations, so an attacker who has
not stolen the client's derivation cannot cheaply generate candidates.

### A7 — User enumeration

Determining whether an address has an account, as a precursor to phishing.

The salt lookup that must precede login returns a deterministic decoy salt for unknown
addresses, derived under the server pepper so it is indistinguishable from a real one.
Login then fails identically either way. Registration and any future password-reset
surface must preserve the same property.

### A8 — Supply chain

A malicious version of a dependency, or of a CI action.

Lockfiles committed and installs performed with `npm ci`. Automated dependency alerts
enabled. GitHub Actions pinned. The crypto package has no third-party dependencies at all,
which removes the most valuable target from the supply chain entirely.

## Explicitly out of scope

These are real risks that this design does not address. They are listed so that no one
mistakes silence for coverage.

- **A compromised endpoint.** Keyloggers, malicious browser extensions with host
  permissions, or malware on the user's machine defeat every control here. No web
  application can defend against this.
- **A weak master password.** A strength floor and a warning are enforced at signup, but
  the user can still choose something guessable, and the entire security of the vault
  rests on that choice.
- **Loss of both master password and recovery key.** The vault is unrecoverable. This is
  the design working as intended, not a failure.
- **Coercion.** Legal or physical compulsion to disclose the master password.
- **Traffic analysis.** An observer with network position learns when the vault is used
  and roughly how large it is.
- **Denial of service.** One small instance with no CDN in front of it, and a table
  provisioned at a fixed ceiling. A determined attacker can make the vault unavailable.
  Availability is explicitly traded for cost; the accepted mitigation is that the data
  lives in a managed service and survives the host, and that an export exists.

## Accepted residual risks

| Risk | Why accepted |
|---|---|
| **The dynamic-DNS name is the entire user-facing trust path (A3).** Whoever controls it can serve modified client code and obtain the master password | Buying a domain removes it for roughly ₹800 a year and remains the cheapest security improvement available. Re-confirmed 2026-11-06: accepted until a domain is bought, and stated on the public security page |
| **Write access to the releases bucket is equivalent to A3.** Releases are hashed, not signed | One person holds write access. Signing releases with a key the host trusts is the step to take if that ever changes |
| **Push access to `main` is equivalent to A3** (0008). No branch protection or required approval | Not available for private repositories on the free plan. One collaborator, two-factor authentication, and a CI key limited to one bucket |
| Structural metadata leaks from a database dump — account count, entries per account, creation and modification times | Closing it requires the single-row model rejected in [0002](../decisions/0002-storage-and-data-model.md) |
| Browser-delivered crypto is inherently weaker than a native client (A3) | Mitigated by CSP and SRI; the native Android client is the structural answer and is on the roadmap |
| PBKDF2 rather than Argon2id | Avoids a WebAssembly dependency in the most sensitive code path; the versioned ciphertext format permits migration without a breaking change |
| One host, no CDN, and an always-free instance that may be reclaimed for idleness | A personal vault whose data outlives the host. Downtime is an inconvenience, not data loss |
| AES-GCM random-IV collision bound of roughly 2^32 encryptions | A personal vault performs on the order of 2^20; revisit if this ever becomes multi-tenant |
