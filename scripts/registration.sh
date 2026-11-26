#!/usr/bin/env bash
# Open or close registration on the running host.
#
#   ./scripts/registration.sh <host> open
#   ./scripts/registration.sh <host> close
#   ./scripts/registration.sh <host> status
#
# The service refuses registration unless ALLOW_REGISTRATION is exactly "true",
# so a missing or misspelled value leaves the vault closed rather than open to
# whoever finds the address. The unit ships with it false; this manages a
# systemd drop-in over the top, because opening registration is a temporary act
# and should look like one.
#
# It verifies the result over HTTPS rather than trusting the restart, since a
# vault left open by accident is the failure that matters.
set -euo pipefail

HOST="${1:?usage: registration.sh <host> open|close|status}"
ACTION="${2:?usage: registration.sh <host> open|close|status}"
KEY="${SSH_KEY:-$HOME/.ssh/oci-vault}"
URL="${VAULT_URL:-https://vault.dev2ops.in}"
DROPIN=/etc/systemd/system/vault-api.service.d/20-registration.conf

ok()   { printf '  \033[1;32mok\033[0m    %s\n' "$1"; }
warn() { printf '  \033[1;33mnote\033[0m  %s\n' "$1"; }
die()  { printf '\033[1;31mError:\033[0m %s\n' "$1" >&2; exit 1; }

ssh_() { ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 "ubuntu@$HOST" "set -e; $*"; }

probe() {
  # 403 means closed. 400 means open and complaining about an empty body,
  # which is what an open endpoint does when asked nothing.
  curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
    -X POST "$URL/api/auth/register" -H 'content-type: application/json' -d '{}'
}

case "$ACTION" in
  status)
    code=$(probe)
    case "$code" in
      403) ok "registration is CLOSED" ;;
      400) warn "registration is OPEN" ;;
      *)   die "unexpected status $code from $URL" ;;
    esac
    ;;

  open)
    ssh_ "sudo mkdir -p /etc/systemd/system/vault-api.service.d
          printf '[Service]\nEnvironment=ALLOW_REGISTRATION=true\n' | sudo tee $DROPIN >/dev/null
          sudo systemctl daemon-reload
          sudo systemctl restart vault-api"
    sleep 6
    [ "$(probe)" = "400" ] || die "the endpoint still refuses; registration did not open"
    ok "registration is OPEN"
    warn "register now, write the recovery key down, then run: $0 $HOST close"
    ;;

  close)
    ssh_ "sudo rm -f $DROPIN
          sudo systemctl daemon-reload
          sudo systemctl restart vault-api"
    sleep 6
    [ "$(probe)" = "403" ] || die "the endpoint still accepts registrations; it is NOT closed"
    ok "registration is CLOSED"
    ;;

  *) die "unknown action: $ACTION" ;;
esac
