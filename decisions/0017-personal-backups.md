# 0017 — Personal backups: each person's own schedule and destination

Status: Accepted
Date: 2026-11-07
Builds: [0001](0001-cryptography-and-key-hierarchy.md), the server backups in `services/api/src/backup.ts`

## Context

Server backups (`BACKUP_*`) belong to the operator: one file holds every account and the server
secrets, restored as a whole. People asked for what Zoho Vault offers: **my own** backup, on
**my own** schedule, to **my own** storage, which I can restore without the operator.

## Decision

**The server writes personal backups, and it needs no key to do so.** A person's vault is
already ciphertext on the server. A personal backup file holds exactly what is needed to open it
again, and nothing that would let the server read it:

```
{ format: "vault-personal-backup", version: 1, createdAt,
  kdf, wrappedVaultKey,                    ← opens with the master password current at backup time
  recovery: { wrappedVaultKey },           ← or with the recovery key current at backup time
  entries: [{ id, blob }], folders: [{ id, blob }], prefs }
```

Restoring is client-side, in Import & export: pick the file, type the master password (or
recovery key) **that was current when the backup was made**, and the items are re-sealed under
today's key and imported. The file carries no auth verifier, no session, no address, and no
history, so a stolen backup is exactly as hard to attack as a stolen database row: an offline
guess against PBKDF2 at 600,000 rounds per try.

**Schedule.** Off, daily, weekly or monthly, at an hour the person picks (stored with their time
zone offset), keeping the last *N* copies (1–30). A server timer checks every five minutes for
schedules that are due. **Back up now** runs one at once.

**Destinations**, chosen per person:

| Destination | Where | What the server stores |
|---|---|---|
| **On this server** | the person's own partition, downloadable from Settings | nothing extra |
| **S3-compatible** | their bucket (AWS, R2, B2, MinIO, Wasabi…) | endpoint, bucket, region, prefix, access key, and the secret key **sealed under a key derived from SERVER_PEPPER** |
| **WebDAV** | Nextcloud, ownCloud, a NAS | URL, user name, and the password sealed the same way |

The destination credentials are the one place the server holds a secret on someone's behalf. It
has to: a schedule runs while nobody is signed in. They are sealed at rest with a server key, so
a database dump alone does not reveal them, and the person is told to create credentials that
can only write to that one bucket or folder. **Email** as a destination is left out: Vault
stores no addresses (threat A2), and a scheduled email needs one.

**Server-side requests to addresses a user typed are dangerous** (SSRF): without care, "back
up to http://169.254.169.254/" or "http://localhost:5432/" would turn the server into a probe of
its own network. So a destination must be `https://`, its host is resolved before every
connection, and any loopback, private, link-local, CGNAT or multicast address is refused. An
operator whose people back up to a NAS on the LAN can allow private addresses
(`PERSONAL_BACKUP_ALLOW_PRIVATE=true`) — a deliberate choice, made on the host. Redirects are not
followed.

**History and status.** Each run records when, where, the size, and success or the error
(without credentials). Settings shows the last runs, and **Test restore** downloads the newest
copy and decrypts it in the browser to prove it opens, without importing anything.

**Organizations** are not covered here: their items are sealed to collection keys, and a
personal backup of shared items would outlive the member's access. An organization backup
(C6) needs its own decision.

## Consequences

- A person can recover a deleted item, or the whole vault after leaving a server, without the
  operator.
- Changing the master password does not re-encrypt old backups: they still open with the old
  password. The restore screen says so, and the recovery key in force at the time also works.
- Outbound connections to S3 and WebDAV come from the server. An operator who must restrict
  egress can turn remote destinations off (`PERSONAL_BACKUP_REMOTE=false`), leaving "On this
  server" only.
