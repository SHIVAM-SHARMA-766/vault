#!/usr/bin/env bash
# Install the release the operator has published, if it is not already live.
#
# Runs on the host from vault-pull.timer. scripts/release.sh uploads a release
# to the releases bucket and points the `current` object at it; this notices,
# fetches it, checks it, installs it, and proves it works — or puts the previous
# release back. Nothing reaches in: the host pulls, so deploying needs no SSH.
# See decisions/0005-pull-based-releases.md.
#
# The `current` object holds one line: "<release id> <sha256 of the tarball>".
#
# What the checks are for, stated plainly: the hash catches a truncated or
# corrupted upload. It does not defend against someone who can write to the
# bucket, because they can write the hash too. Write access to the bucket is
# the control, and the host does not have it.
set -euo pipefail

BUCKET="${RELEASE_BUCKET:?RELEASE_BUCKET is required}"
NAMESPACE="${OBJECTSTORAGE_NAMESPACE:?OBJECTSTORAGE_NAMESPACE is required}"
HOSTNAME_="${VAULT_HOSTNAME:?VAULT_HOSTNAME is required}"
STATE=/srv/vault/releases
KEEP=3

log() { printf '%s\n' "$*"; }
oci_() { oci os object "$@" --auth instance_principal --namespace "$NAMESPACE" --bucket-name "$BUCKET"; }

mkdir -p "$STATE"
chmod 700 "$STATE"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# One request every run. At a five-minute interval that is under 9,000 a month,
# well inside the 50,000 the always-free allowance gives the whole tenancy.
if ! oci_ get --name current --file "$WORK/current" >/dev/null 2>&1; then
  log "no current release published, or the bucket is unreachable; nothing to do"
  exit 0
fi

read -r ID SHA < "$WORK/current" || true
[[ "${ID:-}" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7,40}$ ]] || { log "current names a malformed release id: '${ID:-}'"; exit 1; }
[[ "${SHA:-}" =~ ^[0-9a-f]{64}$ ]] || { log "current carries a malformed hash"; exit 1; }

installed="$(cat "$STATE/installed" 2>/dev/null || true)"
[ "$installed" = "$ID" ] && exit 0

# A release that failed once is not retried every five minutes. Publishing a
# new one, or deleting this file, is how to try again.
if [ "$(cat "$STATE/failed" 2>/dev/null || true)" = "$ID" ]; then
  exit 0
fi

log "installing ${ID} (live: ${installed:-none})"

oci_ get --name "releases/${ID}.tar.gz" --file "$WORK/release.tar.gz" >/dev/null
echo "${SHA}  $WORK/release.tar.gz" | sha256sum -c --quiet - \
  || { log "the downloaded tarball does not match the published hash"; echo "$ID" > "$STATE/failed"; exit 1; }

DEST="$STATE/$ID"
rm -rf "$DEST"
mkdir -p "$DEST"
# GNU tar refuses members with '..' and strips leading '/', so nothing can land
# outside DEST. Ownership in the archive is ignored.
tar -xzf "$WORK/release.tar.gz" -C "$DEST" --no-same-owner --no-same-permissions
( cd "$DEST" && sha256sum -c --quiet MANIFEST ) \
  || { log "the release does not match its own manifest"; echo "$ID" > "$STATE/failed"; rm -rf "$DEST"; exit 1; }
for required in web/app/index.html api/index.mjs api/site/templates/index.html api/site/content/schema.json Caddyfile; do
  [ -f "$DEST/$required" ] || { log "the release is missing $required"; echo "$ID" > "$STATE/failed"; rm -rf "$DEST"; exit 1; }
done

caddy_env() {
  # The Caddyfile is templated with these; they live in the unit's drop-in.
  env VAULT_HOSTNAME="$HOSTNAME_" ACME_EMAIL="${ACME_EMAIL:-}" "$@"
}
caddy_env caddy validate --adapter caddyfile --config "$DEST/Caddyfile" >/dev/null 2>&1 \
  || { log "the release's Caddyfile does not validate"; echo "$ID" > "$STATE/failed"; rm -rf "$DEST"; exit 1; }

install_release() {
  local dir="$1"
  rsync -a --delete "$dir/web/" /srv/vault/web/
  chown -R vault:vault /srv/vault/web
  find /srv/vault/web -type d -exec chmod 755 {} +
  find /srv/vault/web -type f -exec chmod 644 {} +
  # File by file: /srv/vault/api also holds run/secrets.env, which a sync with
  # --delete would remove.
  install -o vault -g vault -m 0644 "$dir/api/index.mjs" /srv/vault/api/index.mjs
  [ -f "$dir/api/index.mjs.map" ] && install -o vault -g vault -m 0644 "$dir/api/index.mjs.map" /srv/vault/api/index.mjs.map
  if [ -d "$dir/api/site" ]; then
    rsync -a --delete "$dir/api/site/" /srv/vault/api/site/
    chown -R vault:vault /srv/vault/api/site
  fi
  install -d -o vault -g vault -m 0755 /srv/vault/site
  # The API renders the public site as it starts, so it restarts before Caddy
  # is pointed at the rendered output.
  systemctl restart vault-api
  local i
  for i in $(seq 1 15); do
    [ -e /srv/vault/site/current ] || [ ! -d "$dir/api/site" ] && break
    sleep 1
  done
  if ! cmp -s "$dir/Caddyfile" /etc/caddy/Caddyfile; then
    install -o root -g root -m 0644 "$dir/Caddyfile" /etc/caddy/Caddyfile
    systemctl reload caddy
  fi
}

verify() {
  local i code
  for i in $(seq 1 15); do
    [ "$(curl -sf --max-time 5 http://127.0.0.1:3000/api/health || true)" = '{"status":"ok"}' ] && break
    sleep 2
  done
  [ "$(curl -sf --max-time 5 http://127.0.0.1:3000/api/health || true)" = '{"status":"ok"}' ] || return 1
  # Through Caddy and TLS, resolved to this host, so the check does not depend
  # on the network hairpinning back to the public address.
  for path in / /app/ /security; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$HOSTNAME_:443:127.0.0.1" "https://$HOSTNAME_$path" || true)
    [ "$code" = 200 ] || { log "$path answered $code"; return 1; }
  done
}

install_release "$DEST"
if verify; then
  echo "$ID" > "$STATE/installed"
  rm -f "$STATE/failed"
  log "live: ${ID}"
else
  log "${ID} failed its checks after install"
  echo "$ID" > "$STATE/failed"
  if [ -n "$installed" ] && [ -d "$STATE/$installed" ]; then
    install_release "$STATE/$installed"
    verify && log "rolled back to ${installed}" || log "ROLLBACK TO ${installed} ALSO FAILED; the service needs attention"
  else
    log "no previous release on disk to roll back to; the service needs attention"
  fi
  exit 1
fi

# Keep the last few for rollback; the rest are in the bucket for ninety days.
ls -1dt "$STATE"/*/ 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -rf
