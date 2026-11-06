#!/usr/bin/env bash
# Set up the host: the systemd units, the backup timer, and the pull timer that
# installs releases. Run it when one of those changes, or after rebuilding the
# host. It does not ship application code.
#
#   ./scripts/deploy.sh <host>
#
# Application code — the API, the client, the site, the Caddyfile — ships with
# scripts/release.sh, which uploads to the releases bucket; the host's
# vault-pull timer installs it. That path needs no inbound access. This one
# does: SSH has no ingress rule by default, so open it for your address first
# and close it after (docs/runbook.md). Needing it rarely is the point.
set -euo pipefail

HOST="${1:?usage: deploy.sh <host or ip>}"

# Neither is secret: the hostname is public DNS and the address only receives
# certificate expiry notices.
VAULT_HOSTNAME="${VAULT_HOSTNAME:-vault-shivam.duckdns.org}"
ACME_EMAIL="${ACME_EMAIL:-developer.shivamsharma@gmail.com}"
RELEASE_BUCKET="${RELEASE_BUCKET:-vault-releases}"
KEY="${SSH_KEY:-$HOME/.ssh/oci-vault}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export SUPPRESS_LABEL_WARNING=True

log() { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
ok()  { printf '  \033[1;32mok\033[0m  %s\n' "$1"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$1" >&2; exit 1; }

# `set -e` on the far side: without it a multi-command chain reports the exit
# code of its last command, so a failure in the middle is silently reported as
# success. That happened once, and the deploy said ok while installing nothing.
ssh_() { ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 "ubuntu@$HOST" "set -e; $*" 2> >(grep -v setlocale >&2); }

NAMESPACE="$(oci os ns get --query data --raw-output 2>/dev/null)" || die "the OCI CLI is not configured"

log "Upload"
ssh_ 'rm -rf /tmp/vault-setup && mkdir -p /tmp/vault-setup'
scp -q -i "$KEY" -o BatchMode=yes \
  "$REPO/services/api/vault-api.service" \
  "$REPO/services/backup/vault-backup.sh" \
  "$REPO/services/backup/vault-backup.service" \
  "$REPO/services/backup/vault-backup.timer" \
  "$REPO/services/release/vault-pull.sh" \
  "$REPO/services/release/vault-pull.service" \
  "$REPO/services/release/vault-pull.timer" \
  "ubuntu@$HOST:/tmp/vault-setup/"
ok "units and scripts uploaded"

log "Install"
ssh_ "sudo install -o root -g root -m 0644 /tmp/vault-setup/vault-api.service /etc/systemd/system/vault-api.service
      sudo rm -f /etc/systemd/system/vault-api.service.d/10-jit.conf
      sudo install -o root -g root -m 0755 /tmp/vault-setup/vault-backup.sh /usr/local/bin/vault-backup.sh
      sudo install -o root -g root -m 0644 /tmp/vault-setup/vault-backup.service /etc/systemd/system/vault-backup.service
      sudo install -o root -g root -m 0644 /tmp/vault-setup/vault-backup.timer /etc/systemd/system/vault-backup.timer
      sudo install -o root -g root -m 0755 /tmp/vault-setup/vault-pull.sh /usr/local/bin/vault-pull.sh
      sudo install -o root -g root -m 0644 /tmp/vault-setup/vault-pull.service /etc/systemd/system/vault-pull.service
      sudo install -o root -g root -m 0644 /tmp/vault-setup/vault-pull.timer /etc/systemd/system/vault-pull.timer
      sudo install -d -o root -g root -m 0755 /etc/vault
      printf 'RELEASE_BUCKET=%s\nOBJECTSTORAGE_NAMESPACE=%s\nVAULT_HOSTNAME=%s\nACME_EMAIL=%s\n' \
        '$RELEASE_BUCKET' '$NAMESPACE' '$VAULT_HOSTNAME' '$ACME_EMAIL' | sudo tee /etc/vault/release.env >/dev/null
      sudo chmod 0644 /etc/vault/release.env
      sudo mkdir -p /etc/systemd/system/caddy.service.d
      printf '[Service]\nEnvironment=VAULT_HOSTNAME=%s\nEnvironment=ACME_EMAIL=%s\n' \
        '$VAULT_HOSTNAME' '$ACME_EMAIL' | sudo tee /etc/systemd/system/caddy.service.d/10-vault.conf >/dev/null
      sudo systemctl daemon-reload
      sudo systemctl enable vault-api >/dev/null
      sudo systemctl enable --now vault-backup.timer >/dev/null
      sudo systemctl enable --now vault-pull.timer >/dev/null
      rm -rf /tmp/vault-setup"
ok "vault-api unit, backup timer, and pull timer installed"

log "Restart"
# The unit may have changed; the code on disk has not.
ssh_ 'sudo systemctl restart vault-api && sleep 4 && systemctl is-active vault-api >/dev/null' \
  || die "vault-api did not come back; check: journalctl -u vault-api -n 50"
ok "vault-api active"

log "Pull"
# Install whatever release is published now, rather than waiting for the timer.
ssh_ 'sudo systemctl start vault-pull.service' \
  || die "the pull failed; check: journalctl -u vault-pull -n 50"
ok "the published release is installed: $(curl -sf --max-time 10 "https://$VAULT_HOSTNAME/release.txt" || echo 'none published yet')"

log "Verify"
for path in / /security /app/; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$VAULT_HOSTNAME$path" || true)
  [ "$code" = 200 ] || die "https://$VAULT_HOSTNAME$path returned ${code:-nothing}"
done
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$VAULT_HOSTNAME/no-such-page" || true)
[ "$code" = 404 ] || die "a missing page returned $code, not 404"
ok "site, security page, and client answer from outside; missing pages are 404"
