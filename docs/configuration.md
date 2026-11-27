# Configuration

Every setting the API server reads. They are environment variables, declared in one place,
`services/api/src/config.ts` (`VARIABLES`); a test fails if this page misses one. The server
checks all of them at start and reports every problem at once, then refuses to start rather
than run half-configured.

No setting has a default that names a particular installation: a server must be told its own
address.

## API server

| Variable | Required | Default | Secret | What it does |
|---|---|---|---|---|
| `VAULT_HOSTNAME` | one of these two | — | | The public hostname, e.g. `vault.example.com` |
| `SITE_ORIGIN` | one of these two | `https://$VAULT_HOSTNAME` | | The public origin with scheme. Only the origin is kept |
| `PORT` | | `3000` | | Port to listen on |
| `HOST` | | `127.0.0.1` | | Address to listen on: `0.0.0.0` in a container, `127.0.0.1` behind a proxy on the same host |
| `TRUST_PROXY` | | `true` | | Take the client address from `X-Forwarded-For`. Set `false` when clients reach the server directly, or they can forge it and dodge rate limits |
| `SERVE_STATIC` | | `false` | | `true` serves the client, website and media from this process with the same headers and caching as the Caddyfile, so only a TLS proxy is needed in front. The container image sets it |
| `WEB_ROOT` | | `web/` beside the server | | The built client, when `SERVE_STATIC` is on |
| `DB_DRIVER` | | `mysql` | | `sqlite` (one file, no database server — personal installs), `postgres` (business installs, several app instances), or `mysql` (the reference instance) |
| `DB_PATH` | sqlite | `/var/lib/vault/vault.db` | | The SQLite file. Its directory must be writable and backed up |
| `DB_HOST` | mysql, postgres | — | | Database host |
| `DB_PORT` | | `3306` / `5432` | | Database port, by driver |
| `DB_USER` | | `vault` | | Database user |
| `DB_NAME` | | `vault` | | Database name; the schema is created and migrated on start |
| `DB_PASSWORD` | mysql, postgres | — | yes | Database password |
| `DB_SSL` | | `false` | | PostgreSQL: `true` requires a verified TLS connection |
| `SECRETS_FILE` | | — | yes | A file holding `SERVER_PEPPER` and `TOKEN_SIGNING_KEY`. Created with fresh secrets (mode 0600) on first start if missing; values in the environment win. The container image uses `/data/secrets.env`. **Back it up with the database** |
| `SERVER_PEPPER` | yes | — | yes | ≥ 32 characters (`openssl rand -base64 32`). Keys address digests; **changing it locks every account out** |
| `TOKEN_SIGNING_KEY` | yes | — | yes | ≥ 32 characters. Signs session tokens; changing it signs everyone out |
| `EDITION` | | `hosted` | | `personal` (one account; no organizations, invitations, service desk, website or emergency access), `business` (the company's server: everything but the website editor) or `hosted` (everything; set on purpose, companies are then created only by the operator's company invitations, [0033](../decisions/0033-hosted-edition.md)). The install profiles set it. Moving down is refused while the server holds a second account or an organization ([0030](../decisions/0030-editions.md)) |
| `ALLOW_REGISTRATION` | | `false` | | `true` forces registration open over the admin panel's setting. For the first account only |
| `ADMIN_EMAILS` | | empty | | Comma-separated owner addresses. Kept only as digests |
| `SITE_SOURCE` | | `site/` beside the server | | Website templates and content |
| `SITE_ROOT` | | `/srv/vault/site` | | Where the rendered website is written; the proxy serves `current/` |

**Schema migrations** run on every start, under a lock, from `services/api/src/storage/migrations.ts`. A server refuses to start against a database a newer release has already upgraded.

Placeholder-looking secrets (`changeme…`, `test…`, `secret…`, `placeholder…`) are refused.

### Mail

Optional. With SMTP configured, admins can email invitations, everyone gets a notice on each
sign-in (and always when their recovery key is used), and the admin panel can send a test
message. The email address is the username (decisions/0037): it is kept encrypted with each
account, so the server can send sign-up codes, approvals and reset links.

| Variable | Default | Secret | What it does |
|---|---|---|---|
| `SMTP_HOST` | — | | Your mail server. Mail is off without it |
| `SMTP_PORT` | `587` | | `587` (STARTTLS, required) or `465` (TLS). Plain-text SMTP is refused |
| `SMTP_USER` | — | | User name, if needed |
| `SMTP_PASSWORD` | — | yes | Password |
| `MAIL_FROM` | — | | Sender, e.g. `Vault <vault@example.com>`. Required with `SMTP_HOST` |
| `MAIL_SIGNIN_NOTICES` | `true` | | `false` stops the per-sign-in email for everyone. Even when `true`, it is opt-in: each person turns it on in Settings (off by default since 2026-11-27). Recovery-key sign-ins are always notified |

### Backups

Backups are off until `BACKUP_PASSPHRASE` and a destination are set. Each is one encrypted
file holding every row and the server secrets — a complete restore with the passphrase, onto
any driver. `node index.mjs backup` takes one now; `node index.mjs restore <file>` restores
into an empty database ([INSTALL.md](INSTALL.md#backups-and-restore)).

| Variable | Default | Secret | What it does |
|---|---|---|---|
| `BACKUP_PASSPHRASE` | — | yes | 16+ characters. Turns scheduled backups on. Keep a copy off the server |
| `BACKUP_DIR` | `/data/backups` in the image | | Local directory for backup files |
| `BACKUP_KEEP` | `14` | | Files kept in `BACKUP_DIR` |
| `BACKUP_INTERVAL_HOURS` | `24` | | Hours between backups; `0` turns the schedule off |
| `BACKUP_S3_ENDPOINT` | — | | S3-compatible endpoint for off-site copies (AWS, R2, B2, OCI, MinIO…) |
| `BACKUP_S3_BUCKET` | — | | Bucket |
| `BACKUP_S3_REGION` | `us-east-1` | | Signing region (`auto` for R2) |
| `BACKUP_S3_ACCESS_KEY` | — | | Access key with write access to that bucket only |
| `BACKUP_S3_SECRET_KEY` | — | yes | Its secret |
| `BACKUP_S3_PREFIX` | `vault/` | | Key prefix |

### Version and updates

| Variable | Default | Secret | Purpose |
|---|---|---|---|
| `VAULT_VERSION` | `dev` | | This build's version. The container image sets it |
| `BREACH_CHECK` | `true` | | `false` turns off the breach check in Password health: no SHA-1 prefixes are relayed to Pwned Passwords and the button is hidden ([0019](../decisions/0019-breach-check.md)) |
| `BREACH_CHECK_URL` | `https://api.pwnedpasswords.com/range/` | | A Pwned Passwords mirror, ending in `/` |
| `METRICS_TOKEN` | | | Turns on Prometheus metrics at `/api/metrics` for requests with `Authorization: Bearer <token>`. Counts only ([monitoring](monitoring.md)) |
| `AUDIT_WEBHOOK_URL` | | | Sends every admin audit record and organization event, as JSON, to a SIEM or log pipeline ([monitoring](monitoring.md)) |
| `AUDIT_WEBHOOK_SECRET` | | | Signs each webhook body: `X-Vault-Signature: sha256=<HMAC-SHA256>` |
| `UPDATE_CHECK` | `true` | | `false` stops the admin panel checking for a newer release. When on, the server asks the release feed at most every 12 hours, with a generic client name and nothing about this install |
| `UPDATE_CHECK_URL` | GitHub latest-release API for this project | | Another feed, for a fork or a mirror |

### Personal backups

Each person can back up their own vault on their own schedule (Settings → Backups;
[decision 0017](../decisions/0017-personal-backups.md)). These settings bound what they may choose.

| Variable | Default | Secret | Purpose |
|---|---|---|---|
| `PERSONAL_BACKUP_REMOTE` | `true` | | `false` keeps personal backups on this server only: no outbound connections to people's S3 buckets or WebDAV folders |
| `PERSONAL_BACKUP_ALLOW_PRIVATE` | `false` | | `true` lets destinations be private or loopback addresses, over plain http — for a NAS on the LAN. Leave off on a server reachable from the internet |
| `GOOGLE_OAUTH_CLIENT_ID` | | | Google Drive as a destination ([decision 0024](../decisions/0024-cloud-drive-backups.md)): a Google Cloud OAuth client (Web application) with the Drive API on. Redirect URI `https://<your address>/api/backups/oauth/callback`, scope `drive.file` |
| `GOOGLE_OAUTH_CLIENT_SECRET` | | ✓ | Its secret |
| `MS_OAUTH_CLIENT_ID` | | | OneDrive as a destination: a Microsoft Entra app registration for personal and work accounts. Same redirect URI; delegated `Files.ReadWrite.AppFolder` and `offline_access` |
| `MS_OAUTH_CLIENT_SECRET` | | ✓ | Its secret |

### Single sign-on

Sign in with your identity provider: Microsoft Entra ID, Google Workspace, Okta, Keycloak,
Authentik ([decision 0021](../decisions/0021-sso.md)). The provider proves who someone is, and
the master password still unlocks the vault. Register `https://<your address>/api/auth/sso/callback`
as the redirect URI. Ask for the `openid email profile` scopes, with a confidential client.
*Require single sign-on* is a server policy in the console (Policies).

| Variable | Default | Secret | Purpose |
|---|---|---|---|
| `OIDC_ISSUER` | | | The provider's issuer URL (https), e.g. `https://login.microsoftonline.com/<tenant>/v2.0` or `https://keycloak.example.com/realms/acme`. Its discovery document must be at `<issuer>/.well-known/openid-configuration` |
| `OIDC_CLIENT_ID` | | | The client id. Required with `OIDC_ISSUER` |
| `OIDC_CLIENT_SECRET` | | ✓ | The client secret. Required with `OIDC_ISSUER` |
| `OIDC_NAME` | `SSO` | | The button says "Sign in with <name>" |
| `OIDC_PROVISION` | `false` | | `true` lets someone the provider signs in, who has no account here yet, create one without an invitation (they still choose a master password) |
| `OIDC_REQUIRE_VERIFIED_EMAIL` | `true` | | `false` accepts an email without `email_verified`, for providers that never send it (Entra ID). Only for a provider whose addresses are all yours |

### SAML 2.0 instead of OIDC

For a provider that only speaks SAML: set these instead of `OIDC_*` (one provider per server).
Give the provider this server's metadata at `https://<host>/api/auth/sso/saml/metadata`. It
expects responses at `https://<host>/api/auth/sso/saml/acs` (HTTP-POST binding), with **signed
assertions** and the address in the NameID (email format) or in `SAML_EMAIL_ATTRIBUTE`.

| Variable | Default | Secret | Purpose |
|---|---|---|---|
| `SAML_IDP_SSO_URL` | | | The provider's single sign-on URL (https, HTTP-Redirect binding) |
| `SAML_IDP_CERT` | | | The provider's signing certificate, PEM or base64 (`\n` for newlines in `.env`) |
| `SAML_SP_ENTITY_ID` | `https://<host>/api/auth/sso/saml/metadata` | | This server's entity id at the provider |
| `SAML_NAME` | `SSO` | | The button says "Sign in with <name>" |
| `SAML_PROVISION` | `false` | | `true` lets someone the provider signs in, with no account here yet, create one without an invitation |
| `SAML_EMAIL_ATTRIBUTE` | | | The attribute that holds the address when the NameID is not one, e.g. `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress` |

## Where they live on the reference instance

| File | Holds | Written by |
|---|---|---|
| `/srv/vault/api/run/secrets.env` (root, 0600) | `DB_*`, `SERVER_PEPPER`, `TOKEN_SIGNING_KEY`, `ADMIN_EMAILS` | The operator, by hand — [runbook](runbook.md#setting-the-server-secrets) |
| `/etc/vault/release.env` (0644) | `VAULT_HOSTNAME`, release bucket and namespace | `scripts/deploy.sh` |
| `vault-api.service` | `PORT`, `ALLOW_REGISTRATION` | The repository |

## Build and development

| Variable | Used by | Default | What it does |
|---|---|---|---|
| `VAULT_API` | `apps/web` dev server | `http://localhost:8080` | Where `/api` is proxied during `vite dev` |
| `SITE_ORIGIN` | `apps/site` check build | `http://localhost:8080` | Absolute URLs in the CI build only; the server re-renders with its own origin |
| `PORT`, `OWNER_EMAIL`, `REGISTRATION` | `npm run dev:stack` | `8080`, `owner@example.test`, open | The local in-memory stack |
