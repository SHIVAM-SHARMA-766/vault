#!/bin/sh
# Vault installer: one command from an empty Linux machine to a running Vault.
#
#   curl -fsSL https://raw.githubusercontent.com/SHIVAM-SHARMA-766/vault/main/deploy/install.sh | sh
#
# It asks for the address people will use, writes deploy/<profile>/.env
# with freshly generated secrets, starts the containers, and prints the
# one-time link that creates the owner account. Run it again to upgrade: an
# existing .env is never overwritten.
#
# Without questions (CI, cloud-init), set:
#   VAULT_HOSTNAME=vault.example.com  VAULT_PROFILE=personal|business
#   VAULT_DIR=/opt/vault              VAULT_YES=1
# Other knobs: VAULT_REF (git branch or tag, default main), VAULT_REPO,
# VAULT_IMAGE (a published image instead of building), VAULT_DRY_RUN=1
# (write the files, start nothing), VAULT_SKIP_FETCH=1 (use the checkout in
# VAULT_DIR exactly as it is — CI tests the commit under test this way).

set -eu

REPO=${VAULT_REPO:-https://github.com/SHIVAM-SHARMA-766/vault.git}
REF=${VAULT_REF:-main}
DRY=${VAULT_DRY_RUN:-}

say()  { printf '%s\n' "$*"; }
step() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# Questions come from the terminal even when this script arrives on a pipe.
ask() { # ask VAR "Question" default
  eval "cur=\${$1:-}"
  if [ -n "$cur" ]; then return; fi
  if [ -n "${VAULT_YES:-}" ] || [ ! -r /dev/tty ]; then eval "$1=\$3"; return; fi
  if [ -n "$3" ]; then printf '%s [%s]: ' "$2" "$3" >/dev/tty; else printf '%s: ' "$2" >/dev/tty; fi
  read -r ans </dev/tty || ans=
  [ -n "$ans" ] || ans=$3
  eval "$1=\$ans"
}

secret() { # secret BYTES — base64 without characters that upset .env or URLs
  if command -v openssl >/dev/null 2>&1; then openssl rand -base64 "$1" | tr -d '\n=+/' | cut -c1-"$(( $1 * 4 / 3 ))"
  else head -c "$1" /dev/urandom | base64 | tr -d '\n=+/'; fi
}

valid_host() { printf '%s' "$1" | grep -Eq '^(localhost|([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63})$'; }

say "Vault installer — a zero-knowledge password manager you run yourself."

# ── Requirements ─────────────────────────────────────────────────────────
step "Checking this machine"
if [ -z "$DRY" ]; then
  command -v docker >/dev/null 2>&1 || fail "Docker is not installed. Install it first: https://docs.docker.com/engine/install/ (or: curl -fsSL https://get.docker.com | sh)"
  docker compose version >/dev/null 2>&1 || fail "The Docker Compose plugin is missing. Install docker-compose-plugin."
  docker info >/dev/null 2>&1 || fail "Docker is installed but this user cannot use it. Run with sudo, or add yourself to the docker group."
fi
command -v git >/dev/null 2>&1 || command -v curl >/dev/null 2>&1 || fail "Neither git nor curl is available to fetch Vault."
say "  ok"

# ── Questions ────────────────────────────────────────────────────────────
step "A few questions"
ask VAULT_PROFILE "Profile — personal (SQLite, one container) or business (PostgreSQL)" personal
case "$VAULT_PROFILE" in personal|business) ;; *) fail "Profile must be personal or business." ;; esac
ask VAULT_HOSTNAME "The address people will use (it must point at this machine; localhost to try it out)" localhost
valid_host "$VAULT_HOSTNAME" || fail "\"$VAULT_HOSTNAME\" is not a host name (example: vault.example.com)."
if [ "$(id -u)" = 0 ]; then default_dir=/opt/vault; else default_dir="$HOME/vault"; fi
ask VAULT_DIR "Install into" "$default_dir"

# ── Fetch ────────────────────────────────────────────────────────────────
step "Fetching Vault ($REF) into $VAULT_DIR"
if [ -n "${VAULT_SKIP_FETCH:-}" ] && [ -f "$VAULT_DIR/deploy/install.sh" ]; then
  say "  using $VAULT_DIR as it is"
elif [ -d "$VAULT_DIR/.git" ]; then
  say "  already here — updating"
  if [ -z "$DRY" ]; then
    git -C "$VAULT_DIR" fetch -q --depth 1 origin "$REF"
    git -C "$VAULT_DIR" checkout -q FETCH_HEAD
  fi
elif [ -f "$VAULT_DIR/deploy/install.sh" ]; then
  say "  using the copy already in $VAULT_DIR"
elif command -v git >/dev/null 2>&1; then
  git clone -q --depth 1 --branch "$REF" "$REPO" "$VAULT_DIR"
else
  mkdir -p "$VAULT_DIR"
  curl -fsSL "${REPO%.git}/archive/refs/heads/$REF.tar.gz" | tar -xz --strip-components=1 -C "$VAULT_DIR"
fi
PROFILE_DIR="$VAULT_DIR/deploy/$VAULT_PROFILE"
[ -f "$PROFILE_DIR/compose.yml" ] || fail "No $PROFILE_DIR/compose.yml — is $VAULT_DIR a Vault checkout?"

# ── Configuration ────────────────────────────────────────────────────────
ENV_FILE="$PROFILE_DIR/.env"
PASSPHRASE=""
if [ -f "$ENV_FILE" ]; then
  step "Keeping the existing $ENV_FILE"
  say "  (delete it and run again to start over — the data volume is kept either way)"
else
  step "Writing $ENV_FILE"
  PASSPHRASE=$(secret 24)
  umask 077
  {
    say "# Written by deploy/install.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). Every setting: docs/configuration.md"
    say "VAULT_HOSTNAME=$VAULT_HOSTNAME"
    say "# personal: one account, yours. business: your company's server (decisions/0030)."
    say "EDITION=$VAULT_PROFILE"
    say "# Encrypts the daily server backup. Keep a copy AWAY from this machine:"
    say "# a backup file plus this passphrase is a complete restore."
    say "BACKUP_PASSPHRASE=$PASSPHRASE"
    if [ "$VAULT_PROFILE" = business ]; then
      say "POSTGRES_PASSWORD=$(secret 24)"
    fi
    if [ -n "${VAULT_IMAGE:-}" ]; then say "VAULT_IMAGE=$VAULT_IMAGE"; fi
    say ""
    say "# Mail (optional): invitations by email and sign-in notices."
    say "# SMTP_HOST=smtp.example.com"
    say "# SMTP_PORT=587"
    say "# SMTP_USER="
    say "# SMTP_PASSWORD="
    say "# MAIL_FROM=Vault <vault@example.com>"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  say "  ok (readable by you only)"
fi

# ── DNS ──────────────────────────────────────────────────────────────────
if [ "$VAULT_HOSTNAME" != localhost ] && command -v getent >/dev/null 2>&1; then
  if ! getent hosts "$VAULT_HOSTNAME" >/dev/null 2>&1; then
    say ""
    say "  ! $VAULT_HOSTNAME does not resolve yet. Point its DNS A/AAAA record at this machine;"
    say "    Caddy keeps retrying the certificate until it does."
  fi
fi

if [ -n "$DRY" ]; then
  step "Dry run: files written, nothing started"
  exit 0
fi

# ── Start ────────────────────────────────────────────────────────────────
cd "$PROFILE_DIR"
# An upgrade: back up first, always (docs/INSTALL.md → Upgrading).
if docker compose ps --status running vault 2>/dev/null | grep -q vault; then
  step "Vault is already running — taking a backup before upgrading"
  if grep -q '^BACKUP_PASSPHRASE=..*' .env; then
    docker compose exec -T vault node index.mjs backup || fail "The backup failed, so nothing was upgraded. See: docker compose logs vault"
  else
    say "  ! No BACKUP_PASSPHRASE in .env, so no backup can be taken. Set one first, or press Ctrl-C."
    sleep 10
  fi
fi
step "Starting Vault (the first build takes a few minutes)"
if [ -n "${VAULT_IMAGE:-}" ]; then docker compose pull -q; docker compose up -d
else docker compose up -d --build; fi

step "Waiting for it to be ready"
i=0
until docker compose ps vault 2>/dev/null | grep -q healthy; do
  i=$((i + 1)); [ $i -lt 90 ] || fail "Vault did not become healthy. See: cd $PROFILE_DIR && docker compose logs vault"
  sleep 2
done
say "  ok"

LINK=$(docker compose logs vault 2>/dev/null | grep -Eo 'https?://[^ ]*/app/\?setup=[A-Z0-9-]+' | tail -1 || true)

step "Done"
say "  Vault is running at https://$VAULT_HOSTNAME/"
if [ -n "$LINK" ]; then
  say ""
  say "  Create your owner account — this link works once, for 7 days:"
  say "    $LINK"
fi
if [ -n "$PASSPHRASE" ]; then
  say ""
  say "  Your backup passphrase (also in $ENV_FILE). Store a copy somewhere else NOW:"
  say "    $PASSPHRASE"
fi
say ""
say "  Next: in the admin panel, Overview → Name and support, set your support address."
say "  Upgrade later by running this installer again. Guide: $VAULT_DIR/docs/INSTALL.md"
