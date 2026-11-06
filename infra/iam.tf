# The instance authenticates as itself.
#
# No credential is written to disk. The dynamic group matches this one instance
# by OCID rather than by compartment — the compartment is shared with other
# projects, and a compartment-wide rule would hand their instances the vault's
# permissions.

resource "oci_identity_dynamic_group" "vault_host" {
  compartment_id = var.tenancy_ocid
  name           = "${local.name}-host"
  description    = "The vault host, and nothing else."
  matching_rule  = "ANY {instance.id = '${oci_core_instance.vault.id}'}"
  freeform_tags  = var.default_tags
}

resource "oci_identity_policy" "vault_host" {
  compartment_id = var.tenancy_ocid
  name           = "${local.name}-host"
  description    = "What the vault host may reach: its backup bucket, and its releases bucket read-only."

  # The database is reached with a username and password over the private
  # subnet, not with an instance principal, so nothing here mentions it. What
  # the instance needs to authenticate as itself for is writing exports.
  statements = [
    # The backup bucket, by name. Read is included so a restore can be done
    # from the host; manage-buckets is not, so it cannot create or delete one.
    "Allow dynamic-group ${oci_identity_dynamic_group.vault_host.name} to manage objects in tenancy where target.bucket.name = '${oci_objectstorage_bucket.backups.name}'",
    "Allow dynamic-group ${oci_identity_dynamic_group.vault_host.name} to read buckets in tenancy where target.bucket.name = '${oci_objectstorage_bucket.backups.name}'",

    # The releases bucket, read-only. The host fetches what it serves from
    # here; it must not be able to change it, or a compromise of the host
    # could plant code that survives a rebuild.
    "Allow dynamic-group ${oci_identity_dynamic_group.vault_host.name} to read objects in tenancy where target.bucket.name = '${oci_objectstorage_bucket.releases.name}'",
  ]

  freeform_tags = var.default_tags
}

# Object Storage manages lifecycle rules as itself, not as the caller who
# created them, so the service principal needs its own grant on the bucket.
# Without it the rule is refused with
#
#   400-InsufficientServicePermissions, Permissions granted to the object
#   storage service principal "objectstorage-<region>" to this bucket are
#   insufficient
#
# which names neither the policy that is missing nor where to put it.
#
# Scoped to this bucket by name rather than to the tenancy, so the grant cannot
# reach the buckets belonging to anything else in the account.
resource "oci_identity_policy" "object_lifecycle" {
  compartment_id = var.tenancy_ocid
  name           = "${local.name}-object-lifecycle"
  description    = "Lets Object Storage expire objects in the vault's backup and releases buckets."

  statements = [
    "Allow service objectstorage-${var.region} to manage object-family in tenancy where target.bucket.name = '${oci_objectstorage_bucket.backups.name}'",
    "Allow service objectstorage-${var.region} to manage object-family in tenancy where target.bucket.name = '${oci_objectstorage_bucket.releases.name}'",
  ]

  freeform_tags = var.default_tags
}
