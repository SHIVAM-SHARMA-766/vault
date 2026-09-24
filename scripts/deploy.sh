#!/usr/bin/env bash
# Build and install the vault onto its host.
#
#   ./scripts/deploy.sh <host>
#
# SSH has no ingress rule by default, so open it first and close it after —
# see docs/runbook.md. That is deliberate friction: this is the host serving a
# password manager, and leaving a way in for convenience is not a trade worth
# making. A pull-based deploy that needs no inbound access at all is the
# intended end state; this is what exists today.
set -euo pipefail

HOST="${1:?usage: deploy.sh <host or ip>}"

# The Caddyfile is templated with these two. They are not secret — the hostname
# is public DNS and the address only receives expiry notices — so they come
# from the environment or from creds, rather than being committed.
VAULT_HOSTNAME="${VAULT_HOSTNAME:-vault-shivam.duckdns.org}"
ACME_EMAIL="${ACME_EMAIL:-developer.shivamsharma@gmail.com}"
KEY="${SSH_KEY:-$HOME/.ssh/oci-vault}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
ok()  { printf '  \033[1;32mok\033[0m  %s\n' "$1"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$1" >&2; exit 1; }

# `set -e` on the far side: without it a multi-command chain reports the exit
# code of its last command, so a failure in the middle is silently reported as
# success. That happened once, and the deploy said ok while installing nothing.
ssh_() { ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 "ubuntu@$HOST" "set -e; $*"; }

log "Tests"
( cd "$REPO" && npm test >/dev/null ) || die "tests failed; nothing was deployed"
ok "both workspaces pass"

log "Build"
( cd "$REPO" && npm run bundle --workspace @vault/api >/dev/null )
[ -f "$REPO/services/api/dist-bundle/index.mjs" ] || die "no bundle produced"
ok "api bundled"

if [ -d "$REPO/apps/web/dist" ]; then
  ok "web build found"
  WEB_BUILD="$REPO/apps/web/dist"
else
  printf '  \033[1;33mskip\033[0m  no web build yet; the placeholder stays\n'
  WEB_BUILD=""
fi

log "Upload"
# To a staging path first: a half-copied file that systemd then tries to run is
# a worse failure than a deploy that stops here.
ssh_ 'mkdir -p /tmp/vault-deploy'
scp -q -i "$KEY" -o BatchMode=yes \
  "$REPO/services/api/dist-bundle/index.mjs" \
  "$REPO/services/api/dist-bundle/index.mjs.map" \
  "$REPO/services/api/vault-api.service" \
  "$REPO/services/backup/vault-backup.sh" \
  "$REPO/services/backup/vault-backup.service" \
  "$REPO/services/backup/vault-backup.timer" \
  "ubuntu@$HOST:/tmp/vault-deploy/"
ok "api and backup uploaded"

if [ -n "$WEB_BUILD" ]; then
  rsync -a -e "ssh -i $KEY -o BatchMode=yes" --delete "$WEB_BUILD/" "ubuntu@$HOST:/tmp/vault-deploy-web/"
  scp -q -i "$KEY" -o BatchMode=yes "$REPO/apps/web/Caddyfile" "ubuntu@$HOST:/tmp/vault-deploy/Caddyfile"
  ok "web and Caddyfile uploaded"
fi

log "Install"
ssh_ 'sudo install -o vault -g vault -m 0644 /tmp/vault-deploy/index.mjs /srv/vault/api/index.mjs
      sudo install -o vault -g vault -m 0644 /tmp/vault-deploy/index.mjs.map /srv/vault/api/index.mjs.map
      sudo install -o root -g root -m 0644 /tmp/vault-deploy/vault-api.service /etc/systemd/system/vault-api.service
      sudo rm -f /etc/systemd/system/vault-api.service.d/10-jit.conf
      sudo install -o root -g root -m 0755 /tmp/vault-deploy/vault-backup.sh /usr/local/bin/vault-backup.sh
      sudo install -o root -g root -m 0644 /tmp/vault-deploy/vault-backup.service /etc/systemd/system/vault-backup.service
      sudo install -o root -g root -m 0644 /tmp/vault-deploy/vault-backup.timer /etc/systemd/system/vault-backup.timer
      sudo systemctl daemon-reload
      sudo systemctl enable vault-api >/dev/null
      sudo systemctl enable --now vault-backup.timer >/dev/null'
ok "api, unit, and backup timer installed"

if [ -n "$WEB_BUILD" ]; then
  # The hostname and the ACME address come from the running Caddy environment
  # rather than being baked in, so this file is the same on any host.
  ssh_ "sudo rsync -a --delete /tmp/vault-deploy-web/ /srv/vault/web/
        sudo chown -R vault:vault /srv/vault/web
        sudo install -o root -g root -m 0644 /tmp/vault-deploy/Caddyfile /etc/caddy/Caddyfile
        sudo mkdir -p /etc/systemd/system/caddy.service.d
        printf '[Service]\nEnvironment=VAULT_HOSTNAME=%s\nEnvironment=ACME_EMAIL=%s\n' \
          '$VAULT_HOSTNAME' '$ACME_EMAIL' | sudo tee /etc/systemd/system/caddy.service.d/10-vault.conf >/dev/null
        sudo systemctl daemon-reload
        sudo systemctl reload-or-restart caddy"
  ok "web and Caddyfile installed"
fi

ssh_ 'rm -rf /tmp/vault-deploy /tmp/vault-deploy-web'

log "Restart"
ssh_ 'sudo systemctl restart vault-api && sleep 4 && systemctl is-active vault-api' \
  || die "the service did not come back; check: journalctl -u vault-api -n 50"
ok "vault-api active"

log "Verify"
# Through Caddy rather than against the process, so the whole path is what is
# being checked.
health=$(ssh_ 'curl -sf --max-time 10 http://127.0.0.1:3000/api/health' || true)
[ "$health" = '{"status":"ok"}' ] || die "health said: ${health:-nothing}"
ok "api answers on localhost"
