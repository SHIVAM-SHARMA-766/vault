# services

Everything that runs on the host besides Caddy. The API has its own
[README](api/README.md); the rest are small shell services with systemd units, installed by
`scripts/deploy.sh` and described operationally in the [runbook](../docs/runbook.md).

| Directory | What runs | When | Writes |
|---|---|---|---|
| [`api/`](api/) | `vault-api.service` — the Node API on 127.0.0.1 | Always | MySQL; the rendered website |
| `backup/` | `vault-backup.sh` — `mysqldump`, gzip, verify, upload, read back | Daily timer | `vault-backups` bucket; `/var/lib/vault/last-backup` |
| `backup/` | `vault-restore-drill.sh` — restore the newest export into a scratch database and compare | Quarterly, by hand (an alarm reminds) | `/var/lib/vault/last-restore-drill`, `restore-drills.log` |
| `release/` | `vault-pull.sh` — fetch the published release, verify, install, health-check, roll back | Every 5 minutes | `/srv/vault` |
| `monitor/` | `vault-probe.sh` — check site, API, certificate, disk, memory, backup and drill age, failed units; post metrics | Every 5 minutes | OCI Monitoring (`vault_health` namespace) |

## Contracts

- **Every service authenticates as the instance** (OCI instance principal); no credential is
  stored for it. Each has only the permission it needs: write one bucket, read another, post
  into one metrics namespace (`infra/iam.tf`).
- **Fail loudly.** The backup refuses to upload a dump that is empty, truncated or missing the
  table, and reads every upload back; the pull agent rolls back a release that fails its
  health check; the probe reports, and alarms (in `infra/monitoring.tf`) decide.
- Thresholds live in Terraform, not on the host, so changing one never needs SSH.
