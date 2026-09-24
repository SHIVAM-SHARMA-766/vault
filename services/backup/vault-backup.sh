#!/usr/bin/env bash
# Export the vault to Object Storage.
#
# This is the only backup that exists. The always-free MySQL tier refuses a
# managed backup policy outright — "Cannot specify backup policy with
# 'CreateDbSystem' operation for an Always Free DB system" — so there is no
# automatic snapshot behind this. If it stops running, there is no backup.
#
# What it writes is ciphertext the server holds no key for, so a leaked export
# is no worse than a leaked database. It still contains the auth verifiers and
# the wrapped keys, so the bucket is private.
#
# Authenticates as the instance, through the dynamic group that matches this
# host's OCID. Nothing is read from disk.
set -euo pipefail

BUCKET="${BACKUP_BUCKET:?BACKUP_BUCKET is required}"
DB_HOST="${DB_HOST:?DB_HOST is required}"
DB_USER="${DB_USER:-vault}"
DB_NAME="${DB_NAME:-vault}"
DB_PASSWORD="${DB_PASSWORD:?DB_PASSWORD is required}"

STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
OBJECT="vault-${STAMP}.sql.gz"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$1"; }

# --single-transaction takes a consistent snapshot without locking, which
# matters because the API keeps writing while this runs.
log "dumping ${DB_NAME}"
MYSQL_PWD="$DB_PASSWORD" mysqldump \
  --host="$DB_HOST" --user="$DB_USER" \
  --single-transaction --skip-lock-tables --no-tablespaces \
  --set-gtid-purged=OFF \
  "$DB_NAME" | gzip -9 > "$WORK/$OBJECT"

size=$(stat -c %s "$WORK/$OBJECT")
[ "$size" -gt 0 ] || { log "the dump is empty; refusing to upload"; exit 1; }

# A truncated gzip uploads perfectly happily and fails only when someone
# finally needs it. Check before, not then.
gzip -t "$WORK/$OBJECT" || { log "the dump is not a valid gzip; refusing to upload"; exit 1; }

# And that it actually contains the table, rather than a dump of nothing.
zcat "$WORK/$OBJECT" | grep -q 'CREATE TABLE `vault`' || {
  log "the dump has no vault table; refusing to upload"; exit 1
}

log "uploading ${OBJECT} (${size} bytes)"
oci os object put \
  --auth instance_principal \
  --bucket-name "$BUCKET" \
  --file "$WORK/$OBJECT" \
  --name "$OBJECT" \
  --content-type application/gzip \
  --no-overwrite >/dev/null

# Read it back. An upload that reported success and stored nothing is the
# failure this whole script exists to prevent.
remote=$(oci os object head --auth instance_principal --bucket-name "$BUCKET" --name "$OBJECT" \
  2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("content-length", 0))')
[ "$remote" = "$size" ] || { log "stored size ${remote} does not match ${size}"; exit 1; }

log "done: ${OBJECT}, ${size} bytes, verified"
