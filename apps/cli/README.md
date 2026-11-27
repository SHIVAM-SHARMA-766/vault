# Vault CLI

Secrets from your Vault on the command line, decrypted on your machine only.

```sh
vault login --server https://vault.example.com --email you@example.com
vault list                                   # item names, no secrets
vault read vault://GitHub/password           # one secret, to stdout
vault run --env-file .env.vault -- npm start # a command with secrets in its environment
vault logout
```

## References

A reference is `vault://<item>/<field>`:

| Field | Value |
|---|---|
| `password`, `username`, `url`, `notes` | the item's own field |
| `totp` | the current one-time code |
| `fields.<name>` | a type's own field (for example `fields.host` on a database item) |
| anything else | a custom field, by its label |

- **Matching:** an item is matched by name, ignoring case. A name that matches more than one
  item, or none, is an error, not a guess. An item's id works too.
- **Spaces:** a value that is a reference and nothing else may contain spaces
  (`vault://Prod database/password`). A reference inside a longer value writes spaces as
  `%20` (`postgres://app:vault://Prod%20database/password@db/app`).

## `vault run`

- **Templates:** `--env-file` takes `KEY=value` lines (comments, `export` and quotes allowed).
  References in values are replaced. References already in the environment are replaced too.
- **What the child gets:** the command runs with the result. `VAULT_MASTER_PASSWORD`,
  `VAULT_SECRET_KEY` and `VAULT_ACCOUNT_PASSWORD` are removed from its environment.

## What is kept, and where

- **On disk:** `~/.config/vault-cli/config.json` (mode 600) holds the server, your address
  and the account sign-in token (decisions/0036). That token only asks to unlock; it opens
  nothing without your master password.
- **Not on disk:** the vault key and decrypted items stay in the process's memory for one
  command, then are wiped. The vault session is signed out again.
- **Master password:** asked for each time, or read from `VAULT_MASTER_PASSWORD`, for CI,
  where the platform's secret store should hold it. Accounts with a secret key also need
  `VAULT_SECRET_KEY`.

## Building

From the repository root: `npm install && npm run build`. The command is
`node apps/cli/dist/src/main.js`, or `npm link -w apps/cli` for `vault` on your path.
