#!/usr/bin/env bash
# Report the vault's health to OCI Monitoring, every five minutes.
#
# Checks the service the way a visitor reaches it — public DNS, TLS, Caddy,
# the API — and the host from the inside: disk, memory, the last verified
# backup, failed units. Each result is posted as a metric in the
# `vault_health` namespace; the alarms in infra/monitoring.tf decide what is
# worth a mail. The probe never decides that itself, so changing a threshold
# is a Terraform change, not a host change.
#
# Authenticates as the instance. The only permission it has is writing into
# that one metrics namespace (infra/iam.tf).
#
#   vault-probe.sh            check and post
#   vault-probe.sh --dry-run  check and print the metrics, post nothing
set -uo pipefail
# No `set -e`: a failed check is a result to report, not a reason to stop.

HOST="${VAULT_HOSTNAME:?VAULT_HOSTNAME is required}"
NAMESPACE="vault_health"
BACKUP_BUCKET="${BACKUP_BUCKET:-vault-backups}"
BACKUP_MARK="${BACKUP_MARK:-/var/lib/vault/last-backup}"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

log() { printf '%s\n' "$1"; }

# 1 when the URL answers 200 within 15 seconds, else 0.
up() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$1" 2>/dev/null)
  [ "$code" = 200 ] && echo 1 || { log "check failed: $1 returned ${code:-nothing}"; echo 0; }
}

api_up=0
if body=$(curl -sf --max-time 15 "https://$HOST/api/health" 2>/dev/null) && printf '%s' "$body" | grep -q '"ok"'; then
  api_up=1
else
  log "check failed: /api/health"
fi
site=$(up "https://$HOST/")
app=$(up "https://$HOST/app/")
site_up=$(( site && app ))

# Days until the certificate served right now expires. -1 when it cannot be read,
# which the certificate alarm treats as expiring.
cert_days_left=-1
if end=$(echo | timeout 15 openssl s_client -servername "$HOST" -connect "$HOST:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null); then
  end_epoch=$(date -d "${end#notAfter=}" +%s 2>/dev/null) && cert_days_left=$(( (end_epoch - $(date +%s)) / 86400 ))
fi

# Hours since the last backup that was verified in the bucket. The backup script
# writes the mark only after reading its upload back; before the first such run
# on this host, ask the bucket instead.
backup_epoch=""
if [ -s "$BACKUP_MARK" ]; then
  backup_epoch=$(cat "$BACKUP_MARK")
else
  newest=$(oci os object list --auth instance_principal --bucket-name "$BACKUP_BUCKET" --all \
    --fields timeCreated --query 'max_by(data, &"time-created")."time-created"' --raw-output 2>/dev/null)
  [ -n "$newest" ] && backup_epoch=$(date -d "$newest" +%s 2>/dev/null)
fi
if [[ "$backup_epoch" =~ ^[0-9]+$ ]]; then
  backup_age_hours=$(( ($(date +%s) - backup_epoch) / 3600 ))
else
  backup_age_hours=9999
  log "no backup found"
fi

disk_used_percent=$(df --output=pcent / | tail -1 | tr -dc '0-9')
memory_used_percent=$(awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{printf "%d", (t-a)*100/t}' /proc/meminfo)
failed_units=$(systemctl list-units --state=failed --no-legend --plain 'vault-*' caddy.service 2>/dev/null | grep -c . || true)

metrics=(api_up site_up cert_days_left backup_age_hours disk_used_percent memory_used_percent failed_units)

if [ "$DRY_RUN" = 1 ]; then
  for m in "${metrics[@]}"; do printf '%-20s %s\n' "$m" "${!m}"; done
  exit 0
fi

# Where to post, and as which compartment: from the instance's own metadata.
meta=$(curl -sf --max-time 5 -H 'Authorization: Bearer Oracle' http://169.254.169.254/opc/v2/instance/) \
  || { log "instance metadata unavailable; nothing posted"; exit 1; }
region=$(printf '%s' "$meta" | python3 -c 'import json,sys; print(json.load(sys.stdin)["canonicalRegionName"])')
compartment=$(printf '%s' "$meta" | python3 -c 'import json,sys; print(json.load(sys.stdin)["compartmentId"])')

now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
payload=$(mktemp)
trap 'rm -f "$payload"' EXIT
{
  printf '['
  sep=''
  for m in "${metrics[@]}"; do
    printf '%s{"namespace":"%s","compartmentId":"%s","name":"%s","dimensions":{"host":"%s"},"datapoints":[{"timestamp":"%s","value":%s}]}' \
      "$sep" "$NAMESPACE" "$compartment" "$m" "$HOST" "$now" "${!m}"
    sep=','
  done
  printf ']'
} > "$payload"

if oci monitoring metric-data post --auth instance_principal \
     --endpoint "https://telemetry-ingestion.$region.oraclecloud.com" \
     --metric-data "file://$payload" >/dev/null; then
  log "posted: api_up=$api_up site_up=$site_up cert_days_left=$cert_days_left backup_age_hours=$backup_age_hours disk=$disk_used_percent% memory=$memory_used_percent% failed_units=$failed_units"
else
  log "posting metrics failed"
  exit 1
fi
