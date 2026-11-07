# deploy

Ready-made ways to run Vault on your own server. Both use the image built from the
repository's `Dockerfile` and put Caddy in front for HTTPS — browsers only allow Vault's
encryption on a secure origin. Full instructions: [docs/INSTALL.md](../docs/INSTALL.md).

| Profile | Contents | For |
|---|---|---|
| [`personal/`](personal/) | Vault (SQLite) + Caddy | One person, a family, a small team; a Raspberry Pi or a small VM |
| [`business/`](business/) | Vault + PostgreSQL + Caddy | A company: a database your team backs up and monitors |
| [`Caddyfile`](Caddyfile) | Shared by both | Automatic certificates for `VAULT_HOSTNAME`; Caddy's local CA for `localhost` |

```sh
cd deploy/personal          # or deploy/business
cp .env.example .env        # set VAULT_HOSTNAME (and POSTGRES_PASSWORD for business)
docker compose up -d
docker compose logs vault | grep -A6 "First-run setup"
```

## Contracts

- **Everything that must survive an upgrade is in volumes**: `vault-data` (the SQLite database,
  the generated server secrets, the rendered website) and, for business, `postgres-data`.
- Vault sets its own security headers; Caddy only terminates TLS. The image trusts
  `X-Forwarded-For` because Caddy sets it — do not publish the Vault container's port
  directly, or set `TRUST_PROXY=false` if you do.
- CI brings the business profile up on every change and checks it over TLS.
