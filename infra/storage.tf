# Encrypted exports.
#
# The exported rows are ciphertext the server holds no key for, so a leaked
# export is no worse than a leaked table and needs no protection the table does
# not already have. The bucket is private regardless.

resource "oci_objectstorage_bucket" "backups" {
  compartment_id = local.compartment_id
  namespace      = data.oci_objectstorage_namespace.this.namespace
  name           = "${local.name}-backups"

  access_type   = "NoPublicAccess"
  versioning    = "Disabled"
  storage_tier  = "Standard"
  freeform_tags = var.default_tags
}

# The always-free Object Storage allowance is 20 GB and 50,000 API requests a
# month. Exports are small and infrequent, but nothing here prunes itself, so
# an expiry rule is what keeps that allowance from filling up unattended.
resource "oci_objectstorage_object_lifecycle_policy" "backups" {
  namespace = data.oci_objectstorage_namespace.this.namespace
  bucket    = oci_objectstorage_bucket.backups.name

  # The service principal's grant has to exist first, and IAM takes a moment to
  # propagate after it does.
  depends_on = [oci_identity_policy.object_lifecycle]

  rules {
    name        = "expire-old-exports"
    action      = "DELETE"
    time_amount = var.backup_retention_days
    time_unit   = "DAYS"
    is_enabled  = true
  }

  rules {
    name        = "abort-incomplete-uploads"
    action      = "ABORT"
    time_amount = 7
    time_unit   = "DAYS"
    is_enabled  = true
    target      = "multipart-uploads"
  }
}

# Releases: what the host serves, pulled by the host itself.
#
# A release is uploaded here by scripts/release.sh and fetched by the host's
# vault-pull timer, so deploying needs no inbound access at all. See
# decisions/0005-pull-based-releases.md.
#
# Whoever can write to this bucket chooses the code the browser runs, which is
# the same position as controlling the hostname (threat model A3). The host can
# only read it; writing is left to the operator's own OCI user.
resource "oci_objectstorage_bucket" "releases" {
  compartment_id = local.compartment_id
  namespace      = data.oci_objectstorage_namespace.this.namespace
  name           = "${local.name}-releases"

  access_type = "NoPublicAccess"
  # Versioning keeps an overwritten `current` pointer recoverable, so a bad
  # release can be rolled back from the bucket as well as from the host.
  versioning    = "Enabled"
  storage_tier  = "Standard"
  freeform_tags = var.default_tags
}

resource "oci_objectstorage_object_lifecycle_policy" "releases" {
  namespace  = data.oci_objectstorage_namespace.this.namespace
  bucket     = oci_objectstorage_bucket.releases.name
  depends_on = [oci_identity_policy.object_lifecycle]

  # Each release is a few hundred kilobytes; ninety days of them is far inside
  # the 20 GB allowance, and older ones are never installed again.
  rules {
    name        = "expire-old-releases"
    action      = "DELETE"
    time_amount = 90
    time_unit   = "DAYS"
    is_enabled  = true
    target      = "objects"
    object_name_filter {
      inclusion_prefixes = ["releases/"]
    }
  }

  rules {
    name        = "expire-old-versions"
    action      = "DELETE"
    time_amount = 30
    time_unit   = "DAYS"
    is_enabled  = true
    target      = "previous-object-versions"
  }

  rules {
    name        = "abort-incomplete-uploads"
    action      = "ABORT"
    time_amount = 7
    time_unit   = "DAYS"
    is_enabled  = true
    target      = "multipart-uploads"
  }
}
