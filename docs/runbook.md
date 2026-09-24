# Runbook

Operational procedures. Written for whoever is doing this at 2am, which is the same
person who built it and will not remember.

Everything this project runs on is declared in [`infra/`](../infra/) and provisioned from
there. There is nothing to configure in a console, and nothing about this project lives in
another repository.

## First deploy

```sh
cd infra
./bootstrap/create-state-bucket.sh     # once, ever — Terraform cannot create its own state bucket
cp terraform.tfvars.example terraform.tfvars   # fill it in
terraform init
terraform plan                          # read it; 0 to destroy is the only acceptable plan
terraform apply
terraform output public_ip
```

**Point the DuckDNS record at that address before the instance finishes booting.** Caddy
requests a certificate on first start, and the ACME challenge fails if the name does not
resolve to the host. If it does fail, fix the record and `systemctl restart caddy`.

## Applying infrastructure changes

**Use `./scripts/apply.sh`, not `terraform apply` directly.** It plans first, says plainly
whether the instance is about to be replaced, and makes you type `replace` if it is.

That guard exists because the mistake it prevents was made three times in one sitting:
an unrelated `apply` — opening SSH, closing it again — carried a pending `cloud-init`
change along with it and replaced the running host. The vault went down each time, and
each time it was a surprise rather than a decision.

**Testing an SSH key needs `IdentitiesOnly=yes`.** Without it, `ssh -i somekey` still
offers every other key it can find, so a revoked key appears to work. Checking a rotated
key without it reported the old one as still valid when the host had already rejected it:

```sh
ssh -i ~/.ssh/oci-vault -o IdentitiesOnly=yes -o BatchMode=yes ubuntu@<host> 'echo ok'
```

**Checking whether a port is closed needs an actual connection.** `nc -z` reported SSH as
open on a host where it was firewalled off; `ssh` to the same port timed out, which is the
truth. On a NAT64 network especially, trust the real client over the probe.

## Rebuilding the host

**Editing `infra/cloud-init.yaml` replaces the instance.** That is deliberate — a host
built by a script that has since changed is a host nobody can reason about — but three
things follow, and forgetting any of them leaves the site down:

1. **The public IP changes.** Repoint the DuckDNS record, or Caddy cannot get a
   certificate:

   ```sh
   cd infra && terraform output -raw public_ip
   curl "https://www.duckdns.org/update?domains=<name>&token=<token>&ip=<new ip>"
   ```

   Caddy retries the ACME challenge with backoff, so it recovers on its own once DNS is
   right. There is no need to restart anything.

   **Always pass `ip=`.** A DuckDNS update without it sets the record to whatever address
   the request came from — which, run from a laptop, points the vault at that laptop.

2. **The disk is gone**, so the secrets file has to be installed again (below) and the
   code redeployed.

3. **The database is not affected.** It is a separate managed service; nothing on the
   instance's disk is the vault.

### Why cloud-init looks the way it does

Two failures are worth knowing about, because both produce symptoms that name nothing
useful and both are already handled.

**The image's own firewall.** OCI's Ubuntu images ship an iptables INPUT chain that
accepts SSH and then REJECTs everything else — and that REJECT sits *ahead* of the chains
ufw installs, so ufw's rules are never reached. The misleading part is that
`ufw status` cheerfully reports 80 and 443 as allowed while both are closed. cloud-init
inserts its rules ahead of the REJECT rather than relying on ufw alone.

**The Caddy package and its conffile.** cloud-init runs `write_files` before `runcmd`, so
a Caddyfile written to `/etc/caddy/Caddyfile` is already there when the package installs.
dpkg then prompts about a conffile it did not ship, fails non-interactively, leaves the
package unconfigured, and never runs its postinst — so the `caddy` user is never created
and the service dies with `status=217/USER`. The config is staged at
`/etc/caddy/Caddyfile.vault` and copied in afterwards.

**And Caddy must be restarted, not just enabled.** Installing the package starts it with
the default Caddyfile, and `systemctl enable --now` does nothing to a service that is
already running. The symptom is a perfectly healthy server showing "Caddy works!" over
plain HTTP with no certificate — which looks like a config that was never copied rather
than one that was never loaded.

## Setting the server secrets

Two values the API needs, both kept off disk in the repository and out of Terraform state:

- **`server-pepper`** keys the HMAC that turns an email address into a database key, and
  the decoy salt returned for unknown addresses.
- **`token-signing-key`** signs access and refresh tokens.

Generate and install them on the host:

```sh
sudo install -o vault -g vault -m 0600 /dev/null /srv/vault/api/run/secrets.env
sudo tee /srv/vault/api/run/secrets.env >/dev/null <<EOT
SERVER_PEPPER=$(openssl rand -base64 32)
TOKEN_SIGNING_KEY=$(openssl rand -base64 48)
EOT
sudo systemctl restart vault-api
```

### What rotating each one costs

**`server-pepper`: rotating it orphans every existing account.** The email digest changes,
so the login pointer can no longer be found. Treat it as permanent; if it must change,
every account has to be registered again.

**`token-signing-key`: rotating it logs everyone out and costs nothing else.** Safe at any
time, and the right response to any suspicion that it leaked.

## Opening registration for the first account

Registration is closed unless `ALLOW_REGISTRATION` is exactly `"true"`, so a missing or
misspelled value refuses rather than leaving the vault open to whoever finds the URL.

```sh
sudo systemctl edit vault-api        # add: Environment=ALLOW_REGISTRATION=true
sudo systemctl restart vault-api
```

Register, **write the recovery key down before closing the tab** — it is shown once and
never transmitted again — then close registration the same way and restart.

## Idle reclamation, which is the thing most likely to bite

Oracle may reclaim an always-free instance whose **CPU, network and memory** all stay
below 20% for seven days. A single-user vault is idle almost all the time.

The wording is conjunctive, so the first move is to measure rather than assume:

```sh
free -m                 # memory used, against 1 GB — 200 MB is 20%
uptime                  # load
vmstat 5 5              # sustained CPU
```

Caddy plus a Node process on a 1 GB instance plausibly holds memory above 20% on its own.
If several days of measurement say otherwise, a keep-warm loop is the blunt answer:

```sh
# /etc/systemd/system/keep-warm.service — burns one core on purpose.
# Only add this if measurement shows it is needed.
[Service]
ExecStart=/usr/bin/nice -n 19 /bin/sh -c 'while :; do :; done'
CPUQuota=50%
Restart=always
```

Also check in the OCI console whether the tenancy is Always Free or has been upgraded to
Pay As You Go. Reclamation applies to always-free-only accounts, so an upgraded tenancy
makes this whole section moot.

## Deploying code

```sh
npm test                                # both workspaces
npm run bundle --workspace @vault/api
npm run build --workspace @vault/web
# then rsync the bundle to /srv/vault/api and the client to /srv/vault/web,
# and: sudo systemctl restart vault-api
```

Caddy needs no restart for a client deploy; it serves whatever is on disk.

## Rotating the host key

The public key is instance metadata, so changing it replaces the instance — everything
under "Rebuilding the host" applies. There is no way to change it in place through
Terraform, and editing `authorized_keys` over SSH instead leaves the repository
describing a key the host no longer accepts.

```sh
mv ~/.ssh/oci-vault ~/.ssh/oci-vault.old && mv ~/.ssh/oci-vault.pub ~/.ssh/oci-vault.old.pub
ssh-keygen -t ed25519 -f ~/.ssh/oci-vault -N '' -C 'vault host, break-glass only'
cd vault && ./scripts/apply.sh          # it will ask, because this replaces the host
```

Afterwards, verify both directions with `IdentitiesOnly=yes` — the old key must be denied
and the new one must work — then destroy the old private key and update
`VAULT_SSH_KEY_B64` in creds.

## Getting on the host

SSH is unreachable by default: `ssh_allowed_cidr` is an empty list, so no ingress rule
exists. Leaving SSH open to the internet on the host that serves a password manager is not
a trade worth making for convenience — an earlier network in this tenancy did exactly
that, and it is not repeated here.

To get in, set the variable to a single address, apply, do the work, then empty it and
apply again:

```sh
terraform apply -var 'ssh_allowed_cidr=["'"$(curl -s https://api.ipify.org)"'/32"]'
# ... work ...
terraform apply
```

The OCI console's serial connection works without any of this and is the better option
for a host that will not boot.

## When something looks wrong

```sh
systemctl status vault-api caddy
journalctl -u vault-api -n 100 --no-pager
journalctl -u caddy -n 50 --no-pager
curl -s https://<hostname>/api/health
```

A 502 from Caddy means the API is down; a connection refused means Caddy is. A
certificate error usually means the DuckDNS record is pointing somewhere else.

## Backups

**This is the only backup.** The always-free MySQL tier refuses a managed backup policy —
*"Cannot specify backup policy with 'CreateDbSystem' operation for an Always Free DB
system"* — so there is no automatic snapshot behind the export. If the timer stops, there
is no backup at all, and nothing will say so.

```sh
systemctl list-timers vault-backup.timer      # when it last ran and when it runs next
journalctl -u vault-backup.service -n 30      # what happened
systemctl start vault-backup.service          # run one now
oci os object list --auth instance_principal --bucket-name vault-backups --query 'data[].{name:name,size:"size"}' --output table
```

**Check this periodically.** A backup that silently stopped a month ago is worse than no
backup, because it is mistaken for one. Making the age of the newest export visible in
the application — rather than only in a journal nobody reads — is the fix this still
wants.

### Restoring

The export is a gzipped `mysqldump` of the one table. Everything in it is ciphertext the
server holds no key for, so restoring it does not require, and does not reveal, the master
password.

A downloaded dump is a complete copy of the database — the auth verifiers and the wrapped
keys included. Work in a directory only root can read, and remove it afterwards. Writing
it to `/tmp` leaves it mode 644 for anyone on the host; that happened once during a
restore test.

```sh
work=$(sudo mktemp -d) && sudo chmod 700 "$work"
sudo oci os object get --auth instance_principal --bucket-name vault-backups \
  --name vault-<timestamp>.sql.gz --file "$work/restore.sql.gz"
sudo gzip -t "$work/restore.sql.gz"            # refuse a truncated file

set -a; . <(sudo cat /srv/vault/api/run/secrets.env); set +a
sudo zcat "$work/restore.sql.gz" | MYSQL_PWD="$DB_PASSWORD" mysql -h "$DB_HOST" -u "$DB_USER" "$DB_NAME"
sudo systemctl restart vault-api

sudo shred -u "$work"/* && sudo rmdir "$work"
```

**Restore into a scratch database first if the live one still has data.** The dump
contains `DROP TABLE IF EXISTS`, so restoring over a working vault replaces it rather
than merging.

### Proving a backup is restorable

Counting rows is not enough — it does not notice corrupted content. Compare the contents
of the live and restored tables, excluding the rate counters, which change constantly:

```sh
q() { MYSQL_PWD="$DB_PASSWORD" mysql -h "$DB_HOST" -u "$DB_USER" -N -B -e "$1"; }
q "SELECT MD5(GROUP_CONCAT(CONCAT(pk,sk,CAST(data AS CHAR)) ORDER BY pk,sk))
   FROM vault.vault WHERE pk NOT LIKE 'RATE#%'"
q "SELECT MD5(GROUP_CONCAT(CONCAT(pk,sk,CAST(data AS CHAR)) ORDER BY pk,sk))
   FROM vault_restore_test.vault WHERE pk NOT LIKE 'RATE#%'"
```

Done on 2026-09-24: eight rows, identical digests. A backup nobody has restored is not a
backup.

## Recovering the vault

The data lives in Oracle NoSQL, not on the instance, so losing the host loses the service
and not the vault. Rebuilding is `terraform apply` and a deploy.

Exports are written to the Object Storage bucket on a schedule. They are ciphertext the
server holds no key for, so a leaked export is no worse than a leaked table.

```sh
oci os object list --bucket-name vault-backups
```

**If both the master password and the recovery key are gone, the vault is gone.** The
server cannot help; that is the design working, not a failure. See
[0001](../decisions/0001-cryptography-and-key-hierarchy.md).

## Tearing it down

The NoSQL table carries `prevent_destroy`, so `terraform destroy` refuses. That is
deliberate: it is the vault.

To genuinely remove it, take an export first, then remove `prevent_destroy` from
`infra/nosql.tf`, apply, and only then destroy. Three deliberate steps, which is the
point.
