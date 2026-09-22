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
