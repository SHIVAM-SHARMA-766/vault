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
  description    = "What the vault host may reach: its own table and its own bucket."

  statements = [
    # The table, by name. Not "any table in the tenancy".
    "Allow dynamic-group ${oci_identity_dynamic_group.vault_host.name} to use nosql-rows in tenancy where target.nosql-table.name = '${oci_nosql_table.vault.name}'",
    "Allow dynamic-group ${oci_identity_dynamic_group.vault_host.name} to read nosql-tables in tenancy where target.nosql-table.name = '${oci_nosql_table.vault.name}'",

    # The backup bucket, by name. Read is included so a restore can be done
    # from the host; manage-buckets is not, so it cannot create or delete one.
    "Allow dynamic-group ${oci_identity_dynamic_group.vault_host.name} to manage objects in tenancy where target.bucket.name = '${oci_objectstorage_bucket.backups.name}'",
    "Allow dynamic-group ${oci_identity_dynamic_group.vault_host.name} to read buckets in tenancy where target.bucket.name = '${oci_objectstorage_bucket.backups.name}'",
  ]

  freeform_tags = var.default_tags
}
