#!/usr/bin/env bash
# One-time: give GitHub Actions the ability to publish releases.
#
#   ./scripts/setup-ci.sh
#
# Generates an API key pair for a new OCI user, vault-ci, that can write to the
# vault-releases bucket and nothing else (infra/ci.tf). Terraform receives only
# the public half. The private half is sent straight to a GitHub Actions secret
# and then deleted from this machine, so it exists in exactly one place.
#
# Run again to rotate: it makes a new key, replaces the old one in OCI and in
# GitHub. Needs: terraform (infra/ initialised), the OCI CLI, and gh logged in
# as the repository owner.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GH_REPO="${GH_REPO:-SHIVAM-SHARMA-766/vault}"

log() { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
ok()  { printf '  \033[1;32mok\033[0m  %s\n' "$1"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$1" >&2; exit 1; }

gh auth status >/dev/null 2>&1 || die "gh is not logged in"
gh repo view "$GH_REPO" >/dev/null 2>&1 || die "cannot see $GH_REPO with this gh login"

WORK="$(mktemp -d)"
chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT

log "Key"
openssl genrsa -out "$WORK/key.pem" 2048 2>/dev/null
openssl rsa -in "$WORK/key.pem" -pubout -out "$WORK/key.pub.pem" 2>/dev/null
ok "2048-bit RSA key generated in a private temporary directory"

log "OCI user"
cd "$REPO_DIR"
# Public, and committed: Terraform reads it on every apply, so opening SSH or
# any other change later does not remove the CI user.
cp "$WORK/key.pub.pem" infra/ci.pub.pem
./scripts/apply.sh
USER_OCID="$(terraform -chdir=infra output -raw ci_user_ocid)"
FINGERPRINT="$(terraform -chdir=infra output -raw ci_key_fingerprint)"
TENANCY="$(grep -E '^\s*tenancy_ocid' infra/terraform.tfvars | head -1 | sed -E 's/.*"(.*)".*/\1/')"
REGION="$(grep -E '^\s*region' infra/terraform.tfvars | head -1 | sed -E 's/.*"(.*)".*/\1/')"
[ -n "$USER_OCID" ] && [ -n "$FINGERPRINT" ] && [ -n "$TENANCY" ] && [ -n "$REGION" ] || die "could not read the CI user's details back"
ok "vault-ci exists, key ${FINGERPRINT}"

log "GitHub secrets"
gh secret set OCI_PRIVATE_KEY  --repo "$GH_REPO" < "$WORK/key.pem"
gh secret set OCI_USER_OCID    --repo "$GH_REPO" --body "$USER_OCID"
gh secret set OCI_FINGERPRINT  --repo "$GH_REPO" --body "$FINGERPRINT"
gh secret set OCI_TENANCY_OCID --repo "$GH_REPO" --body "$TENANCY"
gh secret set OCI_REGION       --repo "$GH_REPO" --body "$REGION"
ok "five secrets set on $GH_REPO; the private key is now only there"

cat <<NOTE

  Commit infra/ci.pub.pem (it is the public half). The release workflow runs on
  every push to main, or by hand from the Actions tab.
NOTE
