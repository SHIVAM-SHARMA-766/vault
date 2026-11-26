#!/usr/bin/env bash
# Turn on mail for the reference instance: invitations, sign-in alerts and
# account-password resets, sent through a Gmail account with an app password.
#
#   VAULT_SMTP_USER=support.dev2ops@gmail.com VAULT_SMTP_PASSWORD=<app password> \
#     ./scripts/set-mail.sh <host>
#
# (or put both in ~/shivam/creds/.env and `set -a; . ~/shivam/creds/.env; set +a` first)
#
# The app password comes from the Google account: 2-Step Verification on, then
# Security → App passwords. It is sent to the host on stdin, never as an
# argument, and written only into the root-owned secrets file. SSH must be
# open for your address (docs/runbook.md, "Getting on the host").
set -euo pipefail

HOST="${1:?usage: set-mail.sh <host or ip>}"
USER_="${VAULT_SMTP_USER:?set VAULT_SMTP_USER (the Gmail address)}"
PASS="${VAULT_SMTP_PASSWORD:?set VAULT_SMTP_PASSWORD (a Gmail app password)}"
NAME="${VAULT_MAIL_NAME:-Vault}"
KEY="${SSH_KEY:-$HOME/.ssh/oci-vault}"
FILE=/srv/vault/api/run/secrets.env

# Gmail shows app passwords in groups of four; the spaces are not part of it.
PASS="${PASS// /}"
[ "${#PASS}" -eq 16 ] || { echo "A Gmail app password is 16 letters; this one is ${#PASS}." >&2; exit 1; }

printf 'SMTP_HOST=smtp.gmail.com\nSMTP_PORT=587\nSMTP_USER=%s\nSMTP_PASSWORD=%s\nMAIL_FROM=%s <%s>\n' "$USER_" "$PASS" "$NAME" "$USER_" |
  ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 "ubuntu@$HOST" "set -e
    tmp=\$(sudo mktemp)
    sudo grep -vE '^(SMTP_HOST|SMTP_PORT|SMTP_USER|SMTP_PASSWORD|MAIL_FROM)=' $FILE | sudo tee \$tmp >/dev/null || true
    sudo tee -a \$tmp >/dev/null
    sudo install -o vault -g vault -m 0600 \$tmp $FILE
    sudo rm -f \$tmp
    sudo systemctl restart vault-api
    sleep 3
    systemctl is-active --quiet vault-api && echo 'vault-api restarted with mail settings'"

URL="https://$(ssh -i "$KEY" -o BatchMode=yes "ubuntu@$HOST" ". /etc/vault/release.env; echo \$VAULT_HOSTNAME")"
if curl -sf "$URL/api/instance" | grep -q '"mail":true'; then
  echo "Mail is on at $URL. Send a test from the console: Server → Overview → Mail, Send a test to…"
else
  echo "The server did not report mail as on; check: journalctl -u vault-api -n 50" >&2
  exit 1
fi
