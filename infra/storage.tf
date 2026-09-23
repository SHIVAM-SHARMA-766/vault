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
