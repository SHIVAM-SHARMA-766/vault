# Known issues and limits

What Vault does not do yet, does imperfectly, or deliberately accepts. Each entry says what
the effect is, why it is the way it is, and what would change it. Plans live in
[ROADMAP.md](ROADMAP.md); the adversaries behind the security items are in
[threat-model.md](threat-model.md).

Last revised: 2026-11-25 (passkey unlock, Argon2id, single sign-on)

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
<summary>🟡 <b>Accounts made before Argon2id keep PBKDF2 until upgraded</b></summary>

**Effect.** New accounts and every password change use Argon2id at 64 MiB
([0028](../decisions/0028-argon2id.md)). An older account stays on PBKDF2 (600,000 rounds)
until its owner upgrades from Settings → Security or changes the master password. PBKDF2 is
strong against strong passwords and weaker than a memory-hard function against weak ones.

**Why.** Upgrading needs the master password, which only the person has.

**Changes when** each account upgrades. The settings card asks until it does.
</details>

<details>
<summary>🔴 <b>Structural metadata is visible in a database dump</b></summary>

**Effect.** How many accounts exist, how many entries and folders each has, and when they
were created and changed. Never names, URLs, usernames or contents — those are encrypted.

**Why.** Hiding counts and times needs one blob per user, rejected in
[decisions/0002](../decisions/0002-storage-and-data-model.md) for its write amplification.
</details>

<details>
<summary>🔴 <b>Collection key grants are not signed (threat A15)</b></summary>

A compromised server could issue a collection key of its own as a "rotation", and members would
encrypt new shared items under it. Nothing already shared is exposed. The fix — signing each key
grant with the granting member's identity and verifying it — needs a signing key on every
account and is the first item of the open crypto decisions.
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
<summary>🟠 <b>The browser extension is not finished</b></summary>

[0029](../decisions/0029-browser-extension.md) is built in stages. What is missing now:

- It is not yet in the Chrome or Firefox store, so it is loaded unpacked from a release zip.
- With the vault locked, a password you submit on a site is not offered for saving; unlock
  first.
- It fills the top frame only, so a login form inside a same-site frame is not filled yet.
- A copied password is not cleared from the clipboard later, as the web app does.
- An account whose only second factor is a security key signs in with a recovery code.
</details>

<details>
<summary>🟠 <b>Single sign-on: the browser extension and organization-level rules</b></summary>

**Effect.** Single sign-on ([0021](../decisions/0021-sso.md)) is one identity provider per
server, required server-wide or not at all. When it is required, the browser extension cannot
sign in for anyone but an owner, because it has no way through the provider yet. On the hosted
edition, a tenant cannot bring its own provider.

**Why.** The first stage covers a company's own server (the business edition), where one
provider and one rule are what is needed.

**Changes when** the extension gets a sign-in through the provider, and when per-organization
providers are designed (a later stage of 0021).
</details>

<details>
<summary>🟡 <b>The secret key is typed on each new browser</b></summary>

[0027](../decisions/0027-secret-key.md) also describes handing the secret key to a new device by
QR code from a signed-in one; that is not built, so it is typed from the Emergency Kit. A
personal backup made while the key was on opens with this browser's copy of the key or with the
recovery key, and an offline copy asks for it. An organization admin cannot see or require it;
it is each person's choice.
</details>

<details>
<summary>🔴 <b>Emergency access trusts the server to keep the waiting period</b></summary>

A grantor's vault key is sealed to their trusted contact when the contact is confirmed; the
server holds that sealed copy and releases it only after a request and the waiting period (or the
grantor's approval). A server colluding with the contact could release it early. The vault key
never rotates, so removing a contact cannot recall a key they already opened. Choose contacts
accordingly. ([0016](../decisions/0016-teams-completion.md), threat A14)
</details>

<details>
<summary>🟠 <b>Some team controls are self-reported or app-side</b></summary>

The minimum master password strength policy uses a score each member's app reports (the server
never sees a master password); the idle-lock policy is applied by the app; opening, revealing and
copying are audited only as reported by the app. "Hide passwords" is a policy, not encryption.
A modified app could bypass these. Two-factor policy, permissions, writes, grants and membership
are enforced and recorded by the server. Shared items have no version history yet; organization
recovery is not offered. ([0016](../decisions/0016-teams-completion.md))
</details>

<details>
<summary>🟡 <b>Rotation re-encrypts a collection in one request</b></summary>

(Items the rotating member cannot decrypt are dropped, so a damaged or planted item never
blocks re-keying.)

A collection is re-keyed in a single request carrying every item, so very large collections
(several thousand items) approach the request size limit. Fine at intended sizes; batched
rotation is phase 3.5 work.
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
itself is nodemailer's, configured to refuse plain text. The admin console's "Send test" is
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

<details>
<summary>🟡 <b>Attachments stay with personal items</b></summary>

Files can be attached to items in your own vault. An item with attachments cannot be moved into a
collection or shared with a person until they are removed. Exports and share links leave
attachments out; personal backups carry them. ([0020](../decisions/0020-attachments-and-offline-copy.md))
</details>

<details>
<summary>🟡 <b>Translations cover the main screens only</b></summary>

Hindi and Spanish are available for sign-in, the vault, items, the sidebar and settings
navigation. Other screens (the admin console, organizations, imports, most help text) still show
in English until their strings are translated.
</details>
