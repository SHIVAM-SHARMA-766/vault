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
| `PORT` | | `3000` | | Port on 127.0.0.1; the reverse proxy forwards `/api/*` to it |
| `DB_HOST` | yes | — | | MySQL host |
| `DB_PORT` | | `3306` | | MySQL port |
| `DB_USER` | | `vault` | | MySQL user |
| `DB_NAME` | | `vault` | | MySQL database; its table is created on first start |
| `DB_PASSWORD` | yes | — | yes | MySQL password |
| `SERVER_PEPPER` | yes | — | yes | ≥ 32 characters (`openssl rand -base64 32`). Keys address digests; **changing it locks every account out** |
| `TOKEN_SIGNING_KEY` | yes | — | yes | ≥ 32 characters. Signs session tokens; changing it signs everyone out |
| `ALLOW_REGISTRATION` | | `false` | | `true` forces registration open over the admin panel's setting. For the first account only |
| `ADMIN_EMAILS` | | empty | | Comma-separated owner addresses. Kept only as digests |
| `SITE_SOURCE` | | `site/` beside the server | | Website templates and content |
| `SITE_ROOT` | | `/srv/vault/site` | | Where the rendered website is written; the proxy serves `current/` |

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
