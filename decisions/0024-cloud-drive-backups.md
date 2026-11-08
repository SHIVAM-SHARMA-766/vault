# 0024: Personal backups to Google Drive and OneDrive

Status: **Proposed**
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
