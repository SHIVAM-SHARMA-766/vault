#!/usr/bin/env bash
# terraform apply, with the check I kept forgetting.
#
#   ./scripts/apply.sh [extra terraform args...]
#
# Editing cloud-init.yaml changes user_data, which replaces the instance — and
# a replacement wipes the disk, changes the public IP, and takes the deployed
# code and the secrets file with it. That is correct behaviour for immutable
# infrastructure and a very easy thing to trigger by accident while applying
# something unrelated, because the pending cloud-init change rides along.
#
# This plans first, says plainly whether the instance is going, and asks.
set -euo pipefail

INFRA="$(cd "$(dirname "${BASH_SOURCE[0]}")/../infra" && pwd)"
PLAN="$(mktemp -t vault-plan.XXXXXX)"
trap 'rm -f "$PLAN"' EXIT

export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required

cd "$INFRA"
terraform plan -input=false -out="$PLAN" "$@" >/dev/null

replaced=$(terraform show -json "$PLAN" | python3 -c '
import json, sys
plan = json.load(sys.stdin)
for r in plan.get("resource_changes", []):
    actions = r["change"]["actions"]
    if "delete" in actions and "create" in actions:
        print(r["address"])
')

terraform show "$PLAN" | grep -E '^  # |^Plan:' || true

if echo "$replaced" | grep -q 'oci_core_instance.vault'; then
  cat <<'WARN'

  ────────────────────────────────────────────────────────────────
  This replaces the instance. That means:
    - the public IP changes, so the DuckDNS record must be repointed
    - the disk is wiped: the deployed code and the secrets file go
    - the vault is down until both are put back
  The database is a separate service and is not affected.
  ────────────────────────────────────────────────────────────────

WARN
  read -r -p "  Type 'replace' to continue: " answer
  [ "$answer" = "replace" ] || { echo "  stopped"; exit 1; }
fi

terraform apply -input=false "$PLAN"
