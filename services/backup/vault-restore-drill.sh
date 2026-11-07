#!/usr/bin/env bash
# The quarterly restore drill: prove the newest backup restores, completely.
#
#   sudo vault-restore-drill.sh
#
# 1. Takes a fresh export (the normal backup service, with its own checks).
# 2. Downloads that export into a root-only directory and checks the gzip.
# 3. Loads it into a scratch database, vault_restore_test, beside the live one.
# 4. Compares the two tables row by row, by digest. Rows that change on their
#    own between the export and the comparison — rate counters, session
#    rotations, activity — are left out; everything a user stored is compared.
# 5. Drops the scratch database and shreds the download, whatever happened.
# 6. On success, records the date in /var/lib/vault/last-restore-drill, which
#    the health probe reports so an alarm says when the next drill is due.
#
# Ciphertext only, as with every backup: no master password is needed or seen.
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "run as root: sudo $0" >&2; exit 1; }
set -a; . /srv/vault/api/run/secrets.env; set +a
BUCKET="${BACKUP_BUCKET:-vault-backups}"
SCRATCH="vault_restore_test"
DB_USER="${DB_USER:-vault}"
DB_NAME="${DB_NAME:-vault}"

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$1"; }
q() { MYSQL_PWD="$DB_PASSWORD" mysql -h "$DB_HOST" -u "$DB_USER" -N -B -e "$1"; }

work="$(mktemp -d)"; chmod 700 "$work"
cleanup() {
  q "DROP DATABASE IF EXISTS $SCRATCH" 2>/dev/null || true
  find "$work" -type f -exec shred -u {} + 2>/dev/null || true
  rmdir "$work" 2>/dev/null || true
}
trap cleanup EXIT

log "taking a fresh export"
systemctl start vault-backup.service
object=$(oci os object list --auth instance_principal --bucket-name "$BUCKET" --all --fields timeCreated,name \
  --query 'max_by(data, &"time-created").name' --raw-output)
[ -n "$object" ] || { log "no export found in $BUCKET"; exit 1; }

log "downloading $object"
oci os object get --auth instance_principal --bucket-name "$BUCKET" --name "$object" --file "$work/dump.sql.gz" >/dev/null
gzip -t "$work/dump.sql.gz"

log "restoring into $SCRATCH"
q "DROP DATABASE IF EXISTS $SCRATCH; CREATE DATABASE $SCRATCH CHARACTER SET utf8mb4" \
  || { log "could not create $SCRATCH; the database user needs CREATE and DROP on it"; exit 1; }
zcat "$work/dump.sql.gz" | MYSQL_PWD="$DB_PASSWORD" mysql -h "$DB_HOST" -u "$DB_USER" "$SCRATCH"

# Everything a person stored, and the system rows that matter; not the rows
# that move by themselves.
volatile="pk LIKE 'RATE#%' OR sk LIKE 'SESSION#%' OR sk LIKE 'ACT#%' OR (pk = 'SYSTEM' AND sk = 'BACKUP')"
digest() { q "SET SESSION group_concat_max_len = 1073741824;
  SELECT COUNT(*), MD5(GROUP_CONCAT(CONCAT(pk, '|', sk, '|', CAST(data AS CHAR)) ORDER BY pk, sk SEPARATOR '\n'))
  FROM $1.vault WHERE NOT ($volatile)"; }
live=$(digest "$DB_NAME")
restored=$(digest "$SCRATCH")
entries=$(q "SELECT COUNT(*) FROM $SCRATCH.vault WHERE sk LIKE 'ENTRY#%'")

if [ "$live" != "$restored" ]; then
  log "MISMATCH: live ${live} vs restored ${restored}"
  log "someone may have changed their vault during the drill; run it again. If it repeats, the backup is not complete."
  exit 1
fi

install -d -m 0755 /var/lib/vault
date +%s > /var/lib/vault/last-restore-drill
printf '%s %s rows=%s entries=%s ok\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$object" "${restored%%	*}" "$entries" >> /var/lib/vault/restore-drills.log
log "passed: ${restored%%	*} rows identical (${entries} entries) from ${object}. Recorded in /var/lib/vault/restore-drills.log"
