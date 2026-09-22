#!/usr/bin/env bash
# Creates this project's Terraform state bucket. Run once, before the first
# `terraform init`, because Terraform cannot create the bucket it stores its
# own state in.
#
# The bucket is this project's alone. Sharing one with another project would
# mean a mistake there could reach this state.
set -euo pipefail

BUCKET="${BUCKET:-vault-tfstate}"
PROFILE="${PROFILE:-oci-s3}"
REGION="${REGION:-ap-mumbai-1}"
NAMESPACE="${NAMESPACE:-bmnjunl7gpj7}"
ENDPOINT="https://${NAMESPACE}.compat.objectstorage.${REGION}.oraclecloud.com"

# Oracle's S3-compatible API rejects the AWS SDK's default chunked-encoding
# checksums. Without these, every call fails with an opaque error.
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required

echo "bucket:   ${BUCKET}"
echo "endpoint: ${ENDPOINT}"

if aws s3api head-bucket --bucket "${BUCKET}" --profile "${PROFILE}" --endpoint-url "${ENDPOINT}" 2>/dev/null; then
  echo "already exists; nothing to do"
  exit 0
fi

aws s3api create-bucket --bucket "${BUCKET}" --profile "${PROFILE}" --endpoint-url "${ENDPOINT}"
echo "created"

# State files are not secret by design, but they do describe the shape of the
# system. Versioning also means a corrupted write is recoverable.
aws s3api put-bucket-versioning --bucket "${BUCKET}" --profile "${PROFILE}" \
  --endpoint-url "${ENDPOINT}" --versioning-configuration Status=Enabled
echo "versioning enabled"
