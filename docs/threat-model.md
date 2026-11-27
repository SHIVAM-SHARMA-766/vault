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
whose accounts these are. The reference instance's exports are dumps of already-encrypted
data.

Self-hosted backups (`.vbk`, [0013](../decisions/0013-distribution-and-releases.md)) are
different in one way: they also carry the server pepper and token key, so that a file is a
complete restore. They are therefore sealed as a whole — AES-256-GCM under a key from scrypt
over the operator's `BACKUP_PASSPHRASE`, with the header authenticated — and a stolen backup
without the passphrase yields neither the secrets nor the structure of the data. A stolen
backup *with* the passphrase is equivalent to A2 plus the pepper: addresses could be tested
against the digests, but vault contents remain encrypted under each user's own keys.

Offline guessing against the wrapped Vault Key is bounded by **Argon2id** at 64 MiB and three
passes ([0028](../decisions/0028-argon2id.md)). Every guess needs that much memory, which blunts
graphics cards and custom chips. Accounts made before it use PBKDF2 at 600,000 iterations until
they upgrade (Settings → Security, or at the next password change). Either way, guessing is
tractable only against a weak master password, which is why a strength floor
is enforced at signup. An account with a **secret key** ([0027](../decisions/0027-secret-key.md),
opt-in) is out of reach of this entirely: its master key also depends on 128 random bits kept
on the person's devices, so a dump gives nothing to guess against. Its sign-in also refuses a
server that stops returning the flag, so a hostile server cannot downgrade a device that holds
the key into sending a password-only auth key.

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

**The part no control above covers.** Whoever controls the hostname can point it at their
own server, obtain a valid certificate, and serve whatever JavaScript they like. None of the
controls above apply, because the browser is talking to them, legitimately, over a valid
certificate. Since 2026-11-26 the reference instance is `vault.dev2ops.in`, a registered
domain, instead of a free dynamic-DNS name (`vault-shivam.duckdns.org`, which now only
redirects). Control sits with the registrar and DNS account. That account has two-factor
authentication and a registrar lock, a CAA record limits certificates to Let's Encrypt, and
DNSSEC is on where the DNS host offers it.

That is materially worse than a compromise of this server, which yields only ciphertext
and auth keys. Here the attacker gets the master password and therefore the vault.

**A second way into the same position: the releases bucket.** Since
[0005](../decisions/0005-pull-based-releases.md) the host installs whatever the
`vault-releases` bucket's `current` object points at. Whoever can write that bucket chooses
the code browsers run. The host itself can only read it; write access belongs to the
operator's OCI user alone, and that user's API key is therefore as sensitive as the domain's
registrar account. The SHA-256 manifest guards against corruption, not against a writer.

**And a third: `main`.** Since [0008](../decisions/0008-release-pipeline.md) every push to
`main` is published by GitHub Actions as `vault-ci`, which can write the releases bucket.
Whoever can push to `main`, take over the GitHub account, or read the repository's Actions
secrets can therefore publish code. Two-factor authentication on GitHub carries the same
weight as at the registrar; the CI key is limited to that one bucket, so a leak of it is bounded to
publishing a release.

This is accepted knowingly. It is the strongest argument for the browser extension (installed
from a store, not served by the hostname) and the native Android client, which is not delivered
over the web at all.

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

### A13 — Social engineering through the service desk

Someone who knows a member's master password but not their second factor files a "lost my
authenticator" request, hoping staff will turn two-factor sign-in off.

Only staff with `users.write` (owner or admin, never the support role) can reset it, never for
an owner, and every reset is audited with the ticket number. The reset screen says, before the
button, that anyone can type an address into the public form and that the person must be
confirmed through another channel — a call, or in person. The requester is told by email when
it happens, so a legitimate owner of the address learns of a reset they did not ask for. Public
requests are rate-limited and reveal nothing about whether an address has an account (A7). A
reset never touches the master password or the vault key: the attacker still needs the master
password.

### A14 — Emergency access released early

A trusted contact, alone or with a compromised server, tries to read a grantor's vault without
waiting. The contact cannot: the sealed vault key is withheld until the grantor approves or the
waiting period after a visible request has passed, and the grantor is shown the request in
Settings and in their security activity. A **server** that colludes with the contact can skip the
wait — the protection is procedural, not cryptographic, and is documented as such. Mitigations:
contacts are confirmed by fingerprint (A11), the grantor chooses the wait, and every request and
access is recorded in the grantor's activity.

### A15 — A hostile server issuing its own collection keys

A compromised server cannot read anything already shared, but it could create a new key
version itself, seal it to members' public keys (sealing needs only public keys) and serve it as
a rotation; members would then encrypt *new* shared items under a key the server knows.
Fingerprint confirmation (A11) does not cover this, because sealed key grants are not yet signed
by the member who made them. Mitigation today: a rotation is recorded in the organization's
audit log with its actor, and a member's app opens only the version the server says is current.
**Planned fix:** sign every org-key and collection-key grant with the granting member's identity
(a signing key beside the encryption key) and verify it against confirmed members' keys.
Found by the phase 3.5 independent review.

**Status (2026-11-08): mitigated** by signed key grants ([0025](../decisions/0025-signed-key-grants.md)). Grants are signed by the owner or an endorsed admin and checked by members against a pinned owner key. The remaining gap is first contact, because the owner's key is pinned on first use: a member who wants certainty compares the owner's fingerprint once. A server can still withhold or delete grants, which is a denial of service, not a disclosure.

### A16 — Personal backups: credentials held for people, and requests to their addresses

Personal backups ([0017](../decisions/0017-personal-backups.md)) add two things the server did
not do before. **It holds a secret on someone's behalf**: the S3 secret key or WebDAV password
for their destination, because a schedule runs while nobody is signed in. Each is sealed with
AES-256-GCM under a key derived from SERVER_PEPPER and bound to the account, so a database dump
alone does not reveal them, and the UI tells people to create credentials limited to one bucket
or folder. Someone holding the database *and* the pepper can read them — and can then reach only
storage that holds ciphertext.

**It connects to addresses a person typed** (SSRF). A destination must be `https://`; the host is
resolved by our own lookup and the connection made to the approved address (no second
resolution for DNS rebinding); loopback, private, link-local, CGNAT, multicast and reserved
addresses are refused, including IPv4-mapped IPv6 spellings; redirects are not followed;
responses are size-capped; runs and test fetches are rate-limited. An operator can turn remote
destinations off (`PERSONAL_BACKUP_REMOTE=false`) or deliberately allow LAN destinations
(`PERSONAL_BACKUP_ALLOW_PRIVATE=true`). The backup file itself carries only ciphertext and the
wrapped vault key: an attacker with a copy faces the same offline guessing (Argon2id, or PBKDF2
for accounts not yet upgraded) as with the database (A2).

**Google Drive and OneDrive** ([0024](../decisions/0024-cloud-drive-backups.md)):
- The secret held is an OAuth refresh token, sealed the same way. It was granted for the
  narrowest scope each provider offers: files Vault created, or Vault's app folder. Its holder
  can reach nothing else in the person's drive, and the person can revoke it at the provider.
- Connecting uses PKCE and a single-use state bound to the account, so a callback cannot attach
  someone else's drive.
- These requests go only to the providers' fixed hosts, never to an address a person typed.

### A17 — Share links: a link that leaks, or a server that ignores its limits

A share link ([0018](../decisions/0018-share-links.md)) carries its own key in the `#fragment`,
which browsers do not send to the server or in a referrer. The server stores only ciphertext,
bound to the link id. **Anyone holding the whole link can open the item** while it lasts, so
expiry and view limits are fixed choices (at most 30 days), the page warns the sender, the
owner sees every open (with the address) in their activity, and a live link can be revoked.
Opening takes a click, so a chat preview cannot spend a one-view link, and opens are rate
limited per address. **The limits are enforced by the server, not by cryptography**: a hostile
or compromised server keeps the ciphertext and can serve it again, but still cannot read it.
Only the link holder has the key. Deleting the account removes every live copy.

### A18 — The breach check's relay

On request, the browser sends a 5-character SHA-1 prefix per password to `/api/breach/range`,
and the server relays it to Pwned Passwords ([0019](../decisions/0019-breach-check.md)). A
prefix matches hundreds of known passwords and responses are padded, so neither the server nor
the breach service learns a password or a full hash. The service sees the server's address,
not the person's. A hostile server could fake a range, hiding a breach or inventing one, but
cannot learn passwords from it. Results are held in memory until lock. `BREACH_CHECK=false`
removes the relay.

### A19 — Admin-set sign-in allow-list and email text

The allow-list (G2) is checked against the client address the server sees, which depends on
`TRUST_PROXY` being right for the deployment (otherwise a client can forge `X-Forwarded-For`).
It is applied at sign-in, recovery sign-in and every refresh, so a stolen refresh token used
from outside the list stops working. Owners are exempt, and an admin cannot save a list that
excludes their own address, so the panel cannot lock everyone out. Admin-written email text
(G6) is plain text only, at most 120 characters for the subject and 1,000 for the message. It
is placed above fixed content, so the standard link, code and security advice cannot be removed.
A malicious admin could still write misleading text, but admins are trusted with accounts
already (A9).

### A20 — Attachments and offline copies

An attachment is encrypted with its own key, which lives only inside the sealed entry
([0020](../decisions/0020-attachments-and-offline-copy.md)). The server sees ciphertext, a size
and a time; it cannot link a file to an entry. A hostile server could withhold or swap blobs, but
a swapped blob fails decryption because the attachment id is bound into it. An **offline copy**
is a file the person holds, as strong as their master password when it was made. Guessing
against it offline costs the same as against a stolen database row (A2). Its page allows no
network, so opening it reveals nothing to anyone.

### A21 — Passkeys and security keys at sign-in

WebAuthn keys ([0022](../decisions/0022-passkeys.md)) are a second factor bound to this server's
origin and relying-party id. A phishing page on another address receives no usable assertion.
Challenges are random, single-use, and expire after five minutes. Signature counters are
recorded. Verification uses @simplewebauthn (attestation "none": the server does not trust a
particular device maker, and needs no metadata service). Admin and help-desk two-factor resets
clear keys as well as the authenticator app, after the verification those flows already require
(A13).

### A21a — Two steps: the account, then the master password

Since [0036](../decisions/0036-account-then-master-password.md) the master password alone does not
sign in. The account step comes first: an account password, which reaches the server only as an
Argon2id-derived proof, plus two-factor. It leaves a long-lived account token in the browser. That
token is good only for asking to unlock, which also needs the master password's proof, so a
stolen token gives guesses under the per-account limit and nothing else. The token is replaced on
every unlock; a replayed one ends every sign-in of the account. The account password can be reset
by email, which therefore protects the account step only; the vault still needs the master
password, which nobody can reset.

### A21a2 — Email addresses are kept (decisions/0037)

Since [0037](../decisions/0037-account-first.md) the email address is the username. It is shown to
the person and to staff, and it is used to send sign-up codes, approvals and reset links. It is
kept on the account, sealed with AES-256-GCM under a key derived from SERVER_PEPPER, which lives
outside the database. A database dump alone does not reveal addresses; the dump plus the pepper
does. Before 0037 only a keyed digest was stored. Vault contents are untouched by this: they
remain readable only with each person's master password.

### A21a3 — A stolen staff session (admin console phase 3)

An access token taken from an administrator's browser lets the thief act as that administrator
until the session ends. Three things limit what it can do:

- **Sensitive actions need the master password recently.** These are role changes, deleting or
  offboarding accounts, resetting someone's two-factor or account password, bulk changes,
  server settings and deleting an organization. They need the master password's proof from
  that device in the last ten minutes. A sign-in counts; a refresh does not. The proof is
  checked like a sign-in and is rate-limited per account.
- **`requireStaffTwoFactor`** keeps any staff account without two-factor sign-in out of the
  console, so a phished password alone does not reach it.
- **Changes are announced.** A role change, a policy or registration change and a deletion are
  emailed to the other owners and admins, so a quiet takeover is noticed.

The audit log remains the record. Admins still cannot read vault contents with any of this.

### A21a4 — Dashboard counters (admin console phase 2)

Sign-ins, failed sign-ins and new vaults are counted per day, as bare numbers, kept 400 days.
They name no account, address or network address, so they add nothing to what a database dump
reveals beyond the activity level of the server.

### A21a5 — Verified domains (admin console phase 4)

A company that verifies a domain by DNS gets its sign-ups approved for a vault at once. That is
only about getting an empty vault of one's own on this server. Someone who controls the
domain's DNS could make that happen for addresses they also control by email, which is no more
than open registration for that domain. It never gives anyone the company's keys: joining the
company still takes an invitation from its admins and a fingerprint check. A domain is held by
one company at a time, and the server checks it in DNS, not on the company's word.

### A21a6 — Admin API tokens and SCIM (admin console phase 5)

An admin API token is a long-lived secret held by a script or a directory. Several things
bound it:

- **Its secret:** 256 random bits, kept only as a SHA-256 hash and compared in constant time.
  It is shown once.
- **Its scopes:** chosen by an owner. Scopes never include `roles.write` or `settings.write`,
  so a token cannot change roles or settings, make tokens, or reach admins and owners (it acts
  with an admin's reach and the console's checks).
- **What it can never reach:** vault contents, because nothing on the server can open them.
- **Its lifetime:** expiry at 30, 90 or 365 days, or never. It is revoked at once from the
  console, and is rate-limited per token.

A stolen token with `users.write` could disable or offboard accounts, which is disruptive but
does not read anything and is in the audit log under the token's name. Through SCIM, a
directory can only invite, disable, enable and offboard. It cannot delete a vault.

### A21a7 — Website icons (design refresh, 2026-11-27)

Items show their website's icon. The app asks this Vault server for it by host name
(`/api/icons/<host>`), with no sign-in, so the server cannot tie a host to an account by token.
It does see the network address that asks, so an operator who logs requests could guess which
sites a person from that address uses.

The server then fetches the icon itself through the same guard as backups (egress.ts):
- https only, public addresses only, the resolved address pinned;
- redirects checked hop by hop, size-capped;
- only raster images (judged by their bytes, never SVG), served with `nosniff` and a
  `default-src 'none'` policy.

Neither the person's browser nor a third party contacts the site. Preferences → *Show website
icons* turns it off, and then the server is never asked.


### A21a8 — Several vaults ([0038](../decisions/0038-several-vaults.md), 2026-11-27)

An account can have vaults besides Personal. Each vault's key is wrapped under the account's vault
key, bound to the vault id. Its name is sealed under its own key. Each entry row carries an opaque
`vaultId`.

**What the server newly learns:** which entries are in the same vault, how many vaults there are,
and when one is renamed. It still learns no names or contents.

**What the server could try:**
- **Point an entry at another vault:** its ciphertext then does not open under that vault's key.
  The app shows it as unreadable and nothing is disclosed.
- **Swap two vaults' wrapped keys:** each key is bound to its id by its AAD, so a swapped key does
  not open.
- **Keep an old version under the old key during a move:** a move must re-seal every saved version
  in one request, and the server refuses a move that leaves one out.

A write without a vault id is Personal, so an older client cannot strand an item under a key it
does not hold.


### A21a9 — Travel mode ([0039](../decisions/0039-travel-mode.md), 2026-11-27)

While travel mode is on, the server leaves vaults not marked safe out of every vault read, and
refuses writes, deletes and moves that touch them.

- **Who can undo it:** turning it off, or marking another vault safe, needs the master password
  within ten minutes. Someone holding an unlocked, signed-in device cannot undo it once that grace
  has passed.
- **What it does not protect against:** someone who obtains the master password. Folder names,
  which are account-wide, stay visible.
- **What the server learns:** that travel mode is on and which vault ids are safe. It learns no
  names.

### A21b — Unlocking with a passkey

A passkey enrolled to unlock ([0034](../decisions/0034-passkey-unlock.md)) is equivalent to the
master password for that vault, and is opt-in per passkey.

- **What the server holds:** the vault key wrapped under an HKDF branch of the passkey's PRF
  output. That output is computed inside the authenticator after user verification and never
  sent, so a database dump gives nothing to guess offline.
- **Sign-in:** names no account (discoverable credentials, A7). It requires user verification
  and a single-use challenge. It obeys the network allow-list, disabled accounts and the
  sign-in rate limits.
- **Binding:** the blobs are bound to the credential id, so a hostile server cannot make one
  passkey open another's blob.
- **What the person must weigh:** a synced passkey is as strong as the account it syncs
  through.

### A21c — Single sign-on

With an identity provider configured ([0021](../decisions/0021-sso.md)), the provider says *who*
someone is. It never holds or releases a key.

- **A compromised provider** can produce a ticket for anyone. Signing in still needs the master
  password (and Vault's own second factor), so the provider alone opens no vault. "Require
  single sign-on" adds the provider to sign-in; it never replaces the password.
- **The ID token** is checked by the server itself: the signature against the provider's
  published keys (asymmetric algorithms only), and issuer, audience, expiry and the nonce
  bound to this browser's start. The code exchange uses PKCE and the client secret.
- **Tickets** are 256 random bits, single use, five minutes, and stored hashed. They travel in
  the URL fragment, so they never reach a server log or a Referer.
- **Owners are exempt from the requirement**, so a provider outage or misconfiguration cannot
  lock the server's operators out.
- **Provisioning**, when on, lets the provider decide who may create an account. Turn it on
  only for a provider whose addresses are all yours.
- **SAML 2.0** (instead of OIDC) ends in the same ticket.
  - **Who checks the signature:** the XML signature is checked by a maintained library
    (`@node-saml/node-saml` with xml-crypto, which guards against signature wrapping), never
    by Vault's own code.
  - **What must hold:** the assertion must be signed by the configured certificate, for this
    server's audience, within its time window (one minute of clock skew), answering a request
    this server made. That request's id is used once, and a replayed assertion is refused.
  - **Where that state lives:** request ids and seen assertions are kept in the database, so
    several servers agree.
  - **Tested refusals:** a response signed with another key, altered after signing, for
    another audience, out of date, unsolicited, or replayed.

### A22 — The organization recovery key

The recovery key ([0026](../decisions/0026-organization-recovery-key.md)) is the secret half of a
key pair, and the org key and every collection key are also sealed to its public half. Whoever
holds it can take an organization over, and that is its purpose, so it is shown once and meant to
be kept offline. The server stores only ciphertext and a SHA-256 verifier of a separate HKDF
branch. Learning that branch at a recovery attempt does not let the server open anything.
Attempts are rate limited (5 per hour per member), refusals are audited, and a recovery notifies
every remaining owner and admin. A hostile server could seal collection keys to a recovery key
of its own, which is A15 again: signed key grants (0025) will cover recovery copies too.

### A23 — The browser extension and phishing pages

The extension ([0029](../decisions/0029-browser-extension.md)) fills passwords into pages, so a
look-alike page is the obvious way to try to get one. It fills only after the person clicks or
presses the shortcut, and only into the tab they acted on. The background reads that tab's URL
from the browser, not from the popup, and fills only an item whose saved URL matches it:

- the same origin, or
- an https page on the same registrable domain, under the Public Suffix List bundled in the
  extension.

So `example.com.evil.io`, `examplee.com`, a neighbour on `github.io`, another port on the same
address, and an http copy of an https site all get nothing. The function that runs in the page
checks `location.origin` again before it writes, and it fills only the top frame, so a
cross-origin frame never receives a password.

Its base install has no standing access to websites (`activeTab`, not all sites), no content
scripts, no `externally_connectable` and no web-accessible resources, so a page cannot talk to
it. Its build refuses a manifest that adds any of these. The vault key and tokens live in
`chrome.storage.session`, which is memory only and closed to content scripts. It reaches only
the server origin the person approved.

**Inside pages** (stage 3) is off by default. Once the person turns it on, a content script runs
in the top frame of every site, except the Vault server's own origin, where the master password
is typed. It holds no keys.

- **What a page can learn:** it asks the background for this page's matching logins only, and
  shows them in a closed shadow root, built with text only, so the page's scripts cannot read
  the list.
- **Submitted passwords:** a password submitted on a page goes to the background only to offer
  saving it. It is kept in session memory for three minutes, for that site only, and it is not
  kept at all while the vault is locked.
- **What a hostile page can do:** offer itself a "save" for its own origin. That stores a login
  for that origin, never another site's password.

**Passkeys** ([0035](../decisions/0035-passkeys-in-the-extension.md)), when turned on, add a
script in the page's own world that wraps `navigator.credentials`. It decides nothing. The
background takes the origin from the browser, refuses an rpId that is not the page's own
registrable domain (or a parent of the host that is not a public suffix), and acts only after a
trusted click in a closed shadow root. Clicks in the card's first 600 ms are ignored. A page can
therefore get a passkey assertion only for itself, and only when the person chooses one. The
private keys live inside sealed items like passwords.

Shared collections in the extension get the same A15 protection as in the web app. It runs the
same grant checks (`grants.ts`), so a collection key the server swapped or signed itself is
refused, and the popup says so.

The extension's code is also part of A3. Loaded from a release zip or a store, it is fixed
when installed rather than served by the hostname on every visit. That narrows A3 for people who
use it, but only once it is distributed through a store (decision 0029, stage 4).

### A11 — Public-key substitution

The server hands out identity public keys ([0009](../decisions/0009-identity-keys-and-sharing.md)).
A hostile server could hand out a key it controls in place of a colleague's, and receive
whatever is shared to "them". Nothing is shared today, so this does not yet apply.

Controls, designed for phase 3 (teams): a public key cannot be replaced once set (enforced now); a
member joining an organization is sealed to only after an admin confirms their fingerprint;
fingerprints are shown to both people so they can be compared out of band.

**Account changes need the password, not just a session.** Changing the master password
and issuing a new recovery key both require proof of the current master password (or, for a
password reset, of the recovery key), checked by the server. A stolen access token can read
ciphertext for at most fifteen minutes, and not at all once its device is signed out (every request checks the session); it cannot take the account's ways back in away from its owner.


Collection items are stored per organization and collection (`COLLI#<org>#<collection>`):
the independent review found that keying them by collection id alone let a same-id collection
in another organization reach them; fixed with a one-time migration.

**Now that sharing exists** ([0015](../decisions/0015-organizations-and-collections.md)):
nothing is sealed to a member until an admin confirms them. The Organizations screen shows the
admin the fingerprint of the key the member accepted with, and tells them to compare it with
the member reading their own fingerprint aloud — on a call or in person, not over a channel the
server could also control. The server refuses to confirm if the member's key has changed since
they accepted. A server that substituted its own key would be caught at that comparison; one
that substituted it later gains nothing, because keys are sealed only to the recorded key.
### A5 — Stolen or shared device

Physical access to an unlocked session.

Keys live in memory only and are discarded on logout, tab close, and idle timeout; each of
those also ends the server session, and Settings lists every signed-in device so one left
signed in elsewhere can be signed out. Nothing
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
Login then fails identically either way. Accounts with a secret key answer `kdf.version: 2`;
about one decoy in eight does too (chosen per address under the pepper, stable), so the flag
alone does not prove that an account exists. Registration and any future password-reset
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
| **The domain is the user-facing trust path (A3).** Whoever controls `dev2ops.in` at the registrar or DNS host can serve modified client code and obtain the master password | A registered domain since 2026-11-26 (it was a free DuckDNS name), with registrar two-factor authentication and lock, a CAA record, and DNSSEC where offered. The store-installed extension is the structural answer |
| **Write access to the releases bucket is equivalent to A3.** Releases are hashed, not signed | One person holds write access. Signing releases with a key the host trusts is the step to take if that ever changes |
| **Push access to `main` is equivalent to A3** (0008). No branch protection or required approval | Not available for private repositories on the free plan. One collaborator, two-factor authentication, and a CI key limited to one bucket |
| Structural metadata leaks from a database dump — account count, entries per account, creation and modification times | Closing it requires the single-row model rejected in [0002](../decisions/0002-storage-and-data-model.md) |
| Browser-delivered crypto is inherently weaker than a native client (A3) | Mitigated by CSP and SRI; the native Android client is the structural answer and is on the roadmap |
| Argon2id runs as WebAssembly, so the policy allows `'wasm-unsafe-eval'` | The module is our own source (`packages/crypto/argon2/argon2.wat`), embedded in the bundle, and CI checks that its bytes match that source. The directive permits compiling WebAssembly only, not JavaScript `eval`. Accounts not yet upgraded keep PBKDF2 |
| One host, no CDN, and an always-free instance that may be reclaimed for idleness | A personal vault whose data outlives the host. Downtime is an inconvenience, not data loss |
| AES-GCM random-IV collision bound of roughly 2^32 encryptions | A personal vault performs on the order of 2^20; revisit if this ever becomes multi-tenant |
