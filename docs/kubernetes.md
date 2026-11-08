# Kubernetes (Helm)

`deploy/helm/vault` installs Vault as one pod, with its data on a persistent volume and an
Ingress for HTTPS.

```sh
kubectl create namespace vault
# Secrets stay out of values: database password, backup passphrase, mail, metrics.
kubectl -n vault create secret generic vault-env \
  --from-literal=BACKUP_PASSPHRASE="$(openssl rand -base64 32)"

helm install vault deploy/helm/vault -n vault \
  --set hostname=vault.example.com \
  --set existingSecret=vault-env \
  --set ingress.className=nginx \
  --set 'ingress.annotations.cert-manager\.io/cluster-issuer=letsencrypt'

kubectl -n vault logs deploy/vault | grep -A6 "First-run setup"   # the owner's setup link
```

## What it creates

- **Deployment:** **one replica**, `Recreate` strategy, non-root (uid 10001), read-only root
  filesystem, no capabilities. Readiness and liveness are checked on `/api/health`. Scheduled
  work (server backups, retention, personal backups) runs inside the process, so a second
  replica would run it twice; the chart does not offer one.
- **PersistentVolumeClaim** at `/data`, kept on uninstall (`helm.sh/resource-policy: keep`). It
  holds the SQLite database, **the server secrets generated on first start**
  (`/data/secrets.env`), the rendered website, and local backups. Back it up.
- **Service** and **Ingress.** TLS is required, and cert-manager is the usual way to get it.
  `TRUST_PROXY=true` is set, because the ingress controller sets `X-Forwarded-For`
  ([reverse-proxy.md](reverse-proxy.md)).

## PostgreSQL

```sh
kubectl -n vault create secret generic vault-env \
  --from-literal=DB_PASSWORD='…' --from-literal=BACKUP_PASSPHRASE='…'
helm install vault deploy/helm/vault -n vault \
  --set hostname=vault.example.com --set existingSecret=vault-env \
  --set database.driver=postgres --set database.host=postgres.db.svc --set database.ssl=true
```

The schema is created and migrated on start. Back up the database your usual way. The volume
still holds the server secrets, which you need to restore.

## Settings

Anything in [configuration.md](configuration.md) goes in `env:` (plain values) or in the
`existingSecret` (secret values). For example, monitoring ([monitoring.md](monitoring.md)):

```yaml
env:
  SMTP_HOST: smtp.example.com
  MAIL_FROM: "Vault <vault@example.com>"
  BACKUP_DIR: /data/backups
# METRICS_TOKEN and AUDIT_WEBHOOK_SECRET in the Secret
```

## Upgrading

```sh
helm upgrade vault deploy/helm/vault -n vault --reuse-values --set image.tag=1.2.0
```

Take a backup first (**Admin panel → System → Back up now**). Migrations run on start, and the
`Recreate` strategy means the old pod has stopped before the new one opens the database.
