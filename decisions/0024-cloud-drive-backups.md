# 0024: Personal backups to Google Drive and OneDrive

Status: Accepted by the operator on 2026-11-25 ("complete the remaining work"); built
Date: 2026-11-08
Backlog: C3

## Context

Personal backups go to the server, to S3-compatible storage, or to WebDAV (0017). People asked
for Google Drive and OneDrive.

## What it takes

Both need **OAuth**. The operator registers Vault as an application with Google (Cloud console,
Drive API, the `drive.file` scope, so Vault sees only the files it creates) and with Microsoft
(Entra app registration, `Files.ReadWrite.AppFolder`). Vault then stores a **refresh token**
per person, sealed like WebDAV passwords today, so scheduled backups can run while the person
is away.

- Both registrations cost nothing. Google requires app verification for the `drive.file` scope
  only past 100 users; until then each person clicks through an "unverified app" screen.
- The server makes requests to `www.googleapis.com` and `graph.microsoft.com`. The egress guard
  (0017) gets a fixed allow-list for these, instead of "any public https host".
- **Simpler alternative that works today:** OneDrive does not speak WebDAV, but Nextcloud, Synology,
  Koofr (whose free plan bridges Google Drive and OneDrive) and pCloud do. A WebDAV bridge needs
  no code.

## Recommendation

Build Google Drive and OneDrive behind `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` and
`MS_OAUTH_CLIENT_ID` / `_SECRET`, each optional. The destination is offered only when its
client is configured. The docs walk an operator through both registrations. Until then, point
people at the WebDAV bridges in the user guide.

## As built

- **Configuration:** `GOOGLE_OAUTH_CLIENT_ID`/`_SECRET` and `MS_OAUTH_CLIENT_ID`/`_SECRET`, each
  optional. A destination is offered only when its client is configured and
  `PERSONAL_BACKUP_REMOTE` allows remote destinations. docs/INSTALL.md walks through both
  registrations.
- **Connecting** (Settings → Backups → Connect):
  - `POST /api/backups/connect/<gdrive|onedrive>` returns the consent URL, with PKCE (S256) and
    a single-use state bound to the person, valid 10 minutes.
  - `GET /api/backups/oauth/callback` exchanges the code and makes that drive the destination,
    keeping the schedule.
  - The browser returns to `/app/settings/backups#cloud=…`, where the person signs in again,
    because the page reloads.
- **Scopes:**
  - Google: `drive.file` plus `openid email`, used for the label only. Offline access with fresh
    consent, so a refresh token is issued. On connect, a *Vault backups* folder is created.
  - Microsoft: `Files.ReadWrite.AppFolder offline_access openid email`; files go to the app
    folder.
- **Storage:** the refresh token is sealed like WebDAV passwords (AES-GCM under a key from the
  pepper, bound to the account) and never returned to a client. Microsoft rotates refresh
  tokens; each new one replaces the stored one.
- **Uploads:**
  - Google: a resumable upload, in two requests of any size.
  - OneDrive: one PUT up to 4 MB; above that, an upload session in 3.2 MB chunks. The bearer
    token is never sent to the pre-authorized upload URL.
- **Test restore and pruning** use the file id (Drive) or name (OneDrive) recorded with each run.
- **Egress:** the server calls only the providers' fixed hosts, never an address a person typed.
- **Errors** are explained in the run history, for example when the person revoked access
  ("connect it again").

**Tests:**
- API, against a mock of both providers:
  - scopes, PKCE and offline access;
  - Drive folder, upload, test restore and pruning;
  - OneDrive chunked upload of a vault over 4 MB, with no bearer token on the upload URL;
  - rotating refresh tokens;
  - refused consent, stale state and revoked access;
  - nothing offered when no app is registered.
- e2e: connect Google Drive, sign in again, back up, and test-restore from the drive.
