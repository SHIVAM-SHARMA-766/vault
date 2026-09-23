# The vault's database.
#
# MySQL HeatWave rather than Oracle NoSQL, which this tenancy cannot create at
# all: its NoSQL limits are read-unit-count 0, write-unit-count 0, and
# table-size-gb 0, so a table is refused with
#
#   read units of 50 exceeds the maximum allowed per tenant of 0
#
# Rather than Autonomous Database, which this tenancy can create but which is
# stopped automatically after seven days of inactivity and may be permanently
# deleted after ninety cumulative days stopped. A vault nobody opened this week
# should not be a vault that is down.
#
# The shape is MySQL.Free — the only one this tenancy offers — at one core and
# 8 GB, which is eight times the memory of the host that talks to it.
#
# Design: ../decisions/0002-storage-and-data-model.md.

resource "random_password" "db_admin" {
  length  = 32
  special = true
  # MySQL rejects some punctuation in a password supplied this way, and a
  # 32-character alphanumeric password with this much entropy needs no help
  # from symbols.
  override_special = "-_"
}

resource "oci_mysql_mysql_db_system" "vault" {
  compartment_id      = local.compartment_id
  availability_domain = data.oci_identity_availability_domains.this.availability_domains[0].name
  display_name        = "${local.name}-db"
  shape_name          = "MySQL.Free"
  mysql_version       = var.mysql_version

  # Private. The database has no public address and is reachable only from
  # inside this VCN — which contains exactly one host, the vault's. Nothing
  # else in the tenancy shares this network.
  subnet_id = oci_core_subnet.public.id

  data_storage_size_in_gb = var.mysql_storage_gb

  admin_username = "vault"
  admin_password = random_password.db_admin.result

  # No backup_policy block. The always-free tier refuses one outright:
  #
  #   400-InvalidParameter, attribute = {backupPolicy} - Cannot specify backup
  #   policy with 'CreateDbSystem' operation for an Always Free DB system
  #
  # So the scheduled export to Object Storage is not a second line of defence
  # here — it is the only one, and it needs to actually run. See
  # ../docs/runbook.md.

  lifecycle {
    ignore_changes = [
      # The always-free tier forces the newest release, so a new one would
      # otherwise destroy and recreate the system underneath the data.
      mysql_version,

      # Write-only: the API never returns either of these, so after an import
      # — or after a password change made anywhere but here — Terraform sees
      # them as absent and plans a replacement that can never converge. The
      # authoritative copy of the password is random_password.db_admin, which
      # is what the output reads.
      admin_password,
      admin_username,
    ]
  }

  freeform_tags = var.default_tags
}
