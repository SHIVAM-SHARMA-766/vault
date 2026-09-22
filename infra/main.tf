# The vault's infrastructure. Everything this project runs on is declared here
# and nowhere else.
#
# One always-free OCI instance serving both the client and the API behind
# Caddy, one Oracle NoSQL table holding the encrypted vault, and one Object
# Storage bucket for exports. Nothing is shared with any other project in the
# tenancy — not the network, not the state file, not the bucket.
#
# Design: ../decisions/. Threat model: ../docs/threat-model.md.
#
# Free-tier constraints that must hold:
#   - Two VM.Standard.E2.1.Micro instances per tenancy, total. This uses one.
#   - NoSQL: three tables, 25 GB each, 133 million reads and writes a month.
#   - Object Storage: 20 GB and 50,000 API requests a month.
#   - An idle always-free instance may be reclaimed. See docs/runbook.md.

locals {
  name = var.name_prefix

  # Everything lives in the root compartment. A separate compartment would be
  # tidier, but it is one more thing to get wrong for a tenancy with one
  # operator, and the name prefix already makes ownership obvious.
  compartment_id = var.tenancy_ocid
}

data "oci_identity_availability_domains" "this" {
  compartment_id = local.compartment_id
}

data "oci_objectstorage_namespace" "this" {
  compartment_id = local.compartment_id
}
