# Known issues and limits

What Vault does not do yet, does imperfectly, or deliberately accepts. Each entry says what
the effect is, why it is the way it is, and what would change it. Plans live in
[ROADMAP.md](ROADMAP.md); the adversaries behind the security items are in
[threat-model.md](threat-model.md).

Last revised: 2026-11-07 (phase 2)

| Severity | Meaning |
|---|---|
| 🔴 | Security risk accepted knowingly |
| 🟠 | Missing or partial capability a user would notice |
| 🟡 | Operational limit of the reference instance |
| ⚪ | Small, by design |

## Security risks accepted

<details open>
<summary>🔴 <b>The hostname is a free dynamic-DNS name (threat A3)</b></summary>

**Effect.** Whoever controls `vault-shivam.duckdns.org` can obtain a certificate for it and
serve modified JavaScript, which would see the master password. The key hierarchy cannot
bound this: the code doing the encryption is the code being replaced.

**Why.** Cost: a domain is about ₹800 a year and the instance is run at $0. Accepted by the
operator on 2026-11-06 and stated on the public security page.

**Changes when** a domain is bought (phase 1, operator), and structurally with the browser
extension (phase 4), whose code is installed from a store rather than served by the hostname.
</details>

<details>
<summary>🔴 <b>Releases are hashed, not signed; <code>main</code> has no required review</b></summary>

**Effect.** Write access to the `vault-releases` bucket, or push access to `main`, decides
what every browser runs — the same weight as the hostname.

**Why.** One person holds both, with two-factor authentication; branch protection with
required review is not available for private repositories on the free plan. The CI key can
write that one bucket and nothing else.

**Changes when** releases are signed with a key the host trusts (phase 2, supply chain).
</details>

<details>
<summary>🔴 <b>PBKDF2, not Argon2id; no secret key mixed into the KDF</b></summary>

**Effect.** After a database breach, offline guessing of a weak master password costs
600,000 SHA-256 rounds per guess — strong against strong passwords, weaker than a
memory-hard function against weak ones.

**Why.** PBKDF2 is in WebCrypto; Argon2id needs WebAssembly in the crypto package, against its
no-dependency rule. A 1Password-style secret key makes a stolen database useless for guessing
but makes every new device need that key. Both are open decisions.

**Changes when** either decision is taken. The ciphertext format is versioned, so migrating
needs no breaking change.
</details>

<details>
<summary>🔴 <b>Structural metadata is visible in a database dump</b></summary>

**Effect.** How many accounts exist, how many entries and folders each has, and when they
were created and changed. Never names, URLs, usernames or contents — those are encrypted.

**Why.** Hiding counts and times needs one blob per user, rejected in
[decisions/0002](../decisions/0002-storage-and-data-model.md) for its write amplification.
</details>

<details>
<summary>🟠 <b>A signed-out device keeps working for up to fifteen minutes</b></summary>

**Effect.** Signing a device out (or "sign out everywhere") stops its refresh token at once,
but an access token it already holds stays valid until it expires, at most 15 minutes. It
can read ciphertext in that window; it still needs the vault key to read anything.

**Why.** Access tokens are verified by signature alone, with no database read per request.

**Changes when** revocation needs to be instant: a per-session check on each request.
</details>

## Product gaps

<details>
<summary>🟠 <b>Import tested with fixtures, not yet with real export files</b></summary>

Each of the nine formats is parsed from a fixture built to that manager's published export
layout, and our own CSV round-trips through the importer. Real exports sometimes differ
(extra columns, localised headers, Zoho Vault's `SecretData` in particular). Phase 1's exit
criterion asks for real files from three managers.
</details>

<details>
<summary>🟠 <b>No WebAuthn or security keys</b></summary>

Two-factor sign-in is TOTP with ten single-use recovery codes. Hardware keys and passkeys
are planned alongside passkey support (phase 4).
</details>

<details>
<summary>🟠 <b>No breach check</b></summary>

Password health finds weak, reused, old and http-only passwords locally. Checking against a
public breach corpus would reveal a 5-character hash prefix per password to that service;
whether to offer it, and how, is an open decision.
</details>

<details>
<summary>🔴 <b>Removing a member does not yet rotate collection keys</b></summary>

Removal stops the server serving anything to that person at once, and marks each collection
they could open "Key rotation due". Until rotation ships (phase 3B step 4), someone removed who
kept a copy of a collection key could read items still under it if they also obtained the
ciphertext some other way. Nothing added through the server reaches them.
</details>

<details>
<summary>🟠 <b>Teams are partly built</b></summary>

Organizations, fingerprint-confirmed members, collections, shared items and per-collection
permissions work. Still to come in phase 3B: key rotation, groups, organization policies,
access audit, emergency access. Shared items have no version history yet, and organization
admins see the names of every collection (they hold the org key) though they open only those
they were granted. ([0015](../decisions/0015-organizations-and-collections.md))
</details>

<details>
<summary>🟠 <b>No browser extension, mobile app, or offline access</b></summary>

The web client is the only client. It needs the server to unlock, and holds keys in memory
only, so a reload means unlocking again — deliberately, so nothing is left in browser
storage. Extension: phase 4. Android: phase 5.
</details>

<details>
<summary>🟠 <b>Self-hosted releases are not published yet</b></summary>

The image, install profiles, backups, mail and signed-release workflow exist and are tested
([INSTALL.md](INSTALL.md)), but no version has been tagged, and the update channel, licence
and pricing are open decisions. Until then an install builds the image from source, which the
profiles do by default. The personal profile has not yet been tried on a physical ARM board.
</details>

<details>
<summary>🟠 <b>Self-hosted backups are taken in memory</b></summary>

A backup reads every row into memory before sealing it. A vault server with tens of
thousands of entries is a few tens of MB — fine for the intended sizes, worth streaming
before very large installs. Off-site retention is the bucket's lifecycle rule, not Vault's.
</details>

<details>
<summary>🟠 <b>Mail is tested against a stand-in, not a live SMTP server</b></summary>

The API tests check every message Vault sends through an injected mailer; the SMTP connection
itself is nodemailer's, configured to refuse plain text. The admin panel's "Send test" is
the check against a real server.
</details>

<details>
<summary>🟠 <b>Service desk tickets are readable by staff</b></summary>

Ticket text is support conversation, not vault data, and is stored as plain text so staff can
read it; every text box says never to include a password, recovery key or code. Staff are not
emailed about new tickets (Vault has no staff addresses) — the admin Overview counts open
ones. ([0014](../decisions/0014-service-desk.md))
</details>

## The reference instance

<details>
<summary>🟡 <b>One small host, one region, no high availability</b></summary>

An always-free `E2.1.Micro` (1 GB RAM) behind no CDN. A host failure is downtime, not data
loss: data is in MySQL HeatWave and in the daily export.
</details>

<details>
<summary>🟡 <b>Oracle may reclaim an idle always-free instance</b></summary>

Applies when CPU, network and memory all stay under 20% for seven days. The health probe now
records memory every five minutes, so the question can be answered with a week of data; the
heartbeat alarm mails if the instance disappears. See the runbook.
</details>

<details>
<summary>🟡 <b>The daily export is the only backup</b></summary>

The always-free database tier refuses managed backups. The export is verified after upload,
its age is alarmed after 30 hours, and a scripted restore drill proves it restores; there is
no point-in-time recovery between exports.
</details>

<details>
<summary>🟡 <b>Alerts arrive by email</b></summary>

OCI Notifications mails the operator; push to a phone needs an HTTPS endpoint such as an
ntfy topic to be configured. Alerts start only after the subscription mail is confirmed.
</details>

## Small, by design

| Limit | Value | Why |
|---|---|---|
| Password history | 20 versions per entry | Bounds storage; older versions drop off |
| Folder depth | 4 levels | Keeps the tree readable; deeper imports are folded into the fourth level |
| Entry size | 380 KB sealed | Bounds a single write; notes, not files |
| Import file | 5 MB | Larger than any real password export |
| Import batch | 100 entries, 50 folders per request | Stays under the per-user rate limit |
| Idle lock | 15 minutes | Keys live in memory only |
| Plain CSV export | Unencrypted by nature | Behind the master password and an acknowledgement; for leaving, not for backup |
| Signed-in device list | Shows the address and browser seen at sign-in | Not geolocated; nothing is sent to a third party |
