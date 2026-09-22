# State lives in this project's own Object Storage bucket, reached through
# Oracle's S3-compatible API. A separate bucket from anything else in the
# tenancy, so that a mistake in another project cannot reach this state and a
# mistake here cannot reach theirs.
#
# Auth is a Customer Secret Key stored as the AWS profile "oci-s3"; Terraform's
# S3 backend is the client, which is why an AWS profile appears in a stack that
# has nothing to do with AWS.
#
# Create the bucket once with bootstrap/create-state-bucket.sh before the first
# `terraform init`.
terraform {
  backend "s3" {
    bucket  = "vault-tfstate"
    key     = "terraform.tfstate"
    region  = "ap-mumbai-1"
    profile = "oci-s3"

    endpoints = {
      s3 = "https://bmnjunl7gpj7.compat.objectstorage.ap-mumbai-1.oraclecloud.com"
    }

    # Oracle implements a subset of the S3 API; these skip checks that would
    # otherwise be made against real AWS endpoints.
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_metadata_api_check     = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
    use_path_style              = true

    # Native S3 lockfile, so no lock table is needed.
    use_lockfile = true
  }
}
