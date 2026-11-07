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
| `SERVER_PEPPER` | yes | — | yes | ≥ 32 characters (`openssl rand -base64 32`). Keys address digests; **changing it locks every account out** |
| `TOKEN_SIGNING_KEY` | yes | — | yes | ≥ 32 characters. Signs session tokens; changing it signs everyone out |
| `ALLOW_REGISTRATION` | | `false` | | `true` forces registration open over the admin panel's setting. For the first account only |
| `ADMIN_EMAILS` | | empty | | Comma-separated owner addresses. Kept only as digests |
| `SITE_SOURCE` | | `site/` beside the server | | Website templates and content |
| `SITE_ROOT` | | `/srv/vault/site` | | Where the rendered website is written; the proxy serves `current/` |

**Schema migrations** run on every start, under a lock, from `services/api/src/storage/migrations.ts`. A server refuses to start against a database a newer release has already upgraded.

Placeholder-looking secrets (`changeme…`, `test…`, `secret…`, `placeholder…`) are refused.

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
