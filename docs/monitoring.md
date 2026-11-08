# Monitoring and audit streaming

Vault exposes two optional feeds for an organization's operations tools:

- **Metrics:** Prometheus text at `/api/metrics`.
- **The audit stream:** every admin and organization event, sent as it happens to a SIEM or log pipeline.

Both are off until configured. Neither carries vault content or email addresses: the server
does not have them.

## Metrics (Prometheus)

Set a long random token and restart:

```sh
METRICS_TOKEN=$(openssl rand -hex 32)
```

Scrape with that token as a bearer token:

```yaml
# prometheus.yml
scrape_configs:
  - job_name: vault
    scheme: https
    metrics_path: /api/metrics
    authorization:
      type: Bearer
      credentials: <METRICS_TOKEN>
    static_configs:
      - targets: [vault.example.com]
```

Without the token the address answers 404 when metrics are off, and 401 when the token is wrong.

| Metric | Type | Meaning |
|---|---|---|
| `vault_info{version}` | gauge | The running version (always 1) |
| `vault_uptime_seconds` | gauge | Since the process started |
| `vault_accounts{state="active\|disabled"}` | gauge | Accounts |
| `vault_items` | gauge | Encrypted items in personal vaults |
| `vault_sessions` | gauge | Signed-in devices |
| `vault_organizations` | gauge | Organizations, including direct shares |
| `vault_invitations_active` | gauge | Unused, unexpired invitations |
| `vault_registration_open` | gauge | 1 when anyone can sign up |
| `vault_backup_last_success_timestamp_seconds` | gauge | Last server backup (0: never) |
| `vault_mail_configured` | gauge | 1 when SMTP is set up |
| `vault_http_requests_total{method,status}` | counter | Requests, by method and status class (`2xx`, `4xx`, …) |
| `vault_http_request_duration_seconds_sum` / `_count` | counter | For the average request time |

`deploy/monitoring/` has a Grafana dashboard (`grafana-dashboard.json`, import it and pick your
Prometheus data source) and alert rules (`alerts.yml`). The alerts fire when:

- the server is down
- no backup has run in 36 hours
- registration is open
- more than 5% of requests are server errors

## The audit stream (SIEM)

```sh
AUDIT_WEBHOOK_URL=https://siem.example.com/vault-events
AUDIT_WEBHOOK_SECRET=$(openssl rand -hex 32)   # optional, recommended
```

Each event is a `POST` with a JSON body:

```json
{ "service": "vault", "origin": "https://vault.example.com", "source": "admin",
  "at": "2026-11-08T10:15:02.114Z", "actor": "<account id>", "action": "settings.policy",
  "detail": "2fa score>=3 activity=90d audit=365d links<=30d" }
```

- `source` is `admin` (the admin panel's audit log) or `organization` (an organization's
  activity: grants, removals, item edits, reported opens, with `orgId`, `collectionId` and
  `itemId`).
- Accounts appear by id. The admin panel's audit view maps them to labels.
- With a secret, `X-Vault-Signature: sha256=<hex HMAC-SHA256 of the raw body>` lets the
  receiver reject forged events.

Delivery is best effort with a 5-second timeout and no retries; the audit log in Vault is the
record. To fill a gap, use **Admin panel → Audit log → CSV / JSON**, which downloads the whole
log. In CSV, any cell starting with `=`, `+`, `-` or `@` is prefixed so a spreadsheet does not run
it as a formula.

Works with anything that accepts JSON over HTTPS: Splunk HTTP Event Collector (behind a small
relay or with a URL token), Elastic or OpenSearch ingest endpoints, Graylog GELF HTTP, Loki
behind a gateway, or a webhook in your automation tool.
