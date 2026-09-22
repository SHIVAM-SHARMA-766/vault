# The vault table.
#
# The shape is the one decided in ../decisions/0002: one partition per user, a
# sort key carrying the item type as a prefix, and no secondary indexes —
# because every attribute worth filtering on is ciphertext the server cannot
# read. Oracle NoSQL expresses that as SHARD(pk) plus sk.
#
# `data` is a JSON column rather than a set of typed columns. The server cannot
# interpret what it holds, so giving it a schema would be a schema it could not
# enforce.

resource "oci_nosql_table" "vault" {
  compartment_id = local.compartment_id
  name           = local.name

  ddl_statement = <<-SQL
    CREATE TABLE IF NOT EXISTS ${local.name} (
      pk STRING,
      sk STRING,
      data JSON,
      PRIMARY KEY (SHARD(pk), sk)
    )
  SQL

  table_limits {
    # The always-free allowance is 133 million reads and 133 million writes a
    # month, which is about 50 a second sustained (50 × 2.6M seconds ≈ 130M).
    # Provisioned at that rate, a flood throttles rather than bills — the same
    # trade made on the previous platform, and the reason it stays at zero.
    max_read_units     = var.nosql_read_units
    max_write_units    = var.nosql_write_units
    max_storage_in_gbs = var.nosql_storage_gb
    capacity_mode      = "PROVISIONED"
  }

  # This table is the vault. Losing it is unrecoverable, so Terraform refuses
  # to be the thing that removes it.
  lifecycle {
    prevent_destroy = true
  }

  freeform_tags = var.default_tags
}
