#!/usr/bin/env bash
# Publish a release. The host picks it up within five minutes, by itself.
#
#   ./scripts/release.sh            build, test, upload, and point `current` at it
#   ./scripts/release.sh --dry-run  build and check the release, upload nothing
#   ./scripts/release.sh --status   what is published, and what the site is serving
#   ./scripts/release.sh --rollback <release id>
#                                   point `current` back at an earlier release
#
# Nothing here touches the host. It uploads to the releases bucket with your
# own OCI credentials; the host's vault-pull timer fetches, verifies, installs,
# checks, and rolls back on failure. See decisions/0005-pull-based-releases.md.
#
# scripts/deploy.sh is still what sets a host up (systemd units, the pull timer
# itself). Code changes go through here.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUCKET="${RELEASE_BUCKET:-vault-releases}"
URL="${VAULT_URL:-https://vault.dev2ops.in}"
export SUPPRESS_LABEL_WARNING=True

log() { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
ok()  { printf '  \033[1;32mok\033[0m  %s\n' "$1"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$1" >&2; exit 1; }

NS="$(oci os ns get --query data --raw-output 2>/dev/null)" || die "the OCI CLI is not configured; nothing was published"
oci_() { oci os object "$@" --namespace "$NS" --bucket-name "$BUCKET"; }

published() {
  local tmp; tmp="$(mktemp)"
  oci_ get --name current --file "$tmp" >/dev/null 2>&1 && cat "$tmp" || echo "none"
  rm -f "$tmp"
}

case "${1:-}" in
  --status)
    printf 'published: %s\n' "$(published)"
    printf 'serving:   %s\n' "$(curl -sf --max-time 10 "$URL/release.txt" || echo unknown)"
    exit 0 ;;
  --rollback)
    TARGET="${2:?usage: release.sh --rollback <release id>}"
    SHA_OBJ="$(mktemp)"; trap 'rm -f "$SHA_OBJ"' EXIT
    oci_ get --name "releases/${TARGET}.tar.gz.sha256" --file "$SHA_OBJ" >/dev/null 2>&1 \
      || die "no release ${TARGET} in the bucket"
    printf '%s %s\n' "$TARGET" "$(cut -d' ' -f1 "$SHA_OBJ")" > "$SHA_OBJ.current"
    oci_ put --name current --file "$SHA_OBJ.current" --force >/dev/null
    ok "current now points at ${TARGET}; the host installs it within five minutes"
    exit 0 ;;
  --dry-run) DRY=1 ;;
  "") DRY=0 ;;
  *) die "unknown option: $1" ;;
esac

cd "$REPO"
# A release is named after the commit it was built from, so what is live can
# always be traced to source. Uncommitted changes would break that.
if [ "$DRY" = 0 ] && [ -n "$(git status --porcelain)" ]; then
  die "the working tree has uncommitted changes; commit them first so the release maps to a commit"
fi
ID="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short=12 HEAD)"

log "Tests"
npm test >/dev/null 2>&1 || die "tests failed; nothing was published"
ok "all workspaces pass"

log "Build"
npm run bundle --workspace @vault/api >/dev/null
npm run build --workspace @vault/web >/dev/null
npm run build --workspace @vault/site >/dev/null
ok "api bundled, client and site built and policy-checked"

STAGE="$(mktemp -d -t vault-release.XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT
chmod 755 "$STAGE"
mkdir -p "$STAGE/r/web/app" "$STAGE/r/api/site"
cp -R apps/web/dist/. "$STAGE/r/web/app/"
cp services/api/dist-bundle/index.mjs services/api/dist-bundle/index.mjs.map "$STAGE/r/api/"
# The website ships as templates, schema, defaults and static files. The API
# renders it on the host with whatever content is published in the admin panel.
cp -R apps/site/templates apps/site/static apps/site/content "$STAGE/r/api/site/"
cp apps/web/Caddyfile "$STAGE/r/Caddyfile"
printf '%s\n' "$ID" > "$STAGE/r/RELEASE"
# Public on purpose: a commit id reveals nothing, and it is how this script and
# anyone else can tell which release is being served. It is a static file of
# the site, so every render carries it.
printf '%s\n' "$ID" > "$STAGE/r/api/site/static/release.txt"
( cd "$STAGE/r" && find . -type f ! -name MANIFEST -printf '%P\n' | sort | xargs -d '\n' sha256sum > MANIFEST )
tar -czf "$STAGE/release.tar.gz" -C "$STAGE/r" .
SHA="$(sha256sum "$STAGE/release.tar.gz" | cut -d' ' -f1)"
printf '%s  release.tar.gz\n' "$SHA" > "$STAGE/release.tar.gz.sha256"
ok "${ID} ($(du -h "$STAGE/release.tar.gz" | cut -f1), $(wc -l < "$STAGE/r/MANIFEST") files)"

if [ "$DRY" = 1 ]; then
  tar -tzf "$STAGE/release.tar.gz" | sed 's|^\./||' | grep -v '/$' | sort | sed 's/^/    /'
  ok "dry run: nothing uploaded"
  exit 0
fi

log "Upload"
# The tarball and its hash first, the pointer last: the host never sees a
# `current` naming something that is not there yet.
oci_ put --name "releases/${ID}.tar.gz" --file "$STAGE/release.tar.gz" --content-type application/gzip --no-overwrite >/dev/null
oci_ put --name "releases/${ID}.tar.gz.sha256" --file "$STAGE/release.tar.gz.sha256" --content-type text/plain --no-overwrite >/dev/null
printf '%s %s\n' "$ID" "$SHA" > "$STAGE/current"
oci_ put --name current --file "$STAGE/current" --content-type text/plain --force >/dev/null
ok "published: $(git log -1 --format=%s)"

log "Waiting for the host (checks every five minutes)"
for _ in $(seq 1 44); do
  if [ "$(curl -sf --max-time 10 "$URL/release.txt" || true)" = "$ID" ]; then
    ok "live: ${ID}"
    exit 0
  fi
  sleep 10
done
die "not live after seven minutes; check on the host: journalctl -u vault-pull -n 50"
