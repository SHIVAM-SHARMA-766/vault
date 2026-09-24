# The instance.
#
# One always-free micro running Caddy and the API. Caddy terminates TLS with a
# certificate it obtains itself, serves the built client from disk, sets every
# security header the threat model requires, and proxies /api/* to the Node
# process beside it. The client and the API therefore share an origin without
# anything sitting in front of them.

resource "oci_core_instance" "vault" {
  compartment_id      = local.compartment_id
  availability_domain = data.oci_identity_availability_domains.this.availability_domains[0].name
  display_name        = "${local.name}-host"
  shape               = var.instance_shape
  freeform_tags       = var.default_tags

  source_details {
    source_type             = "image"
    source_id               = var.instance_image_ocid
    boot_volume_size_in_gbs = 50
  }

  # Flexible shapes need an explicit allocation; the fixed micro shape does not
  # accept one. Present only when an A1.Flex is chosen.
  dynamic "shape_config" {
    for_each = endswith(var.instance_shape, ".Flex") ? [1] : []
    content {
      ocpus         = 2
      memory_in_gbs = 12
    }
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.public.id
    nsg_ids          = [oci_core_network_security_group.this.id]
    assign_public_ip = true
    hostname_label   = "host"
  }

  metadata = {
    ssh_authorized_keys = file(pathexpand(var.ssh_public_key_path))
    # Nothing secret goes in here. Instance metadata is readable by anything
    # running on the host and by anyone with the right permission on the API,
    # so the database password and the two server secrets are installed
    # separately into a root-owned file. See ../docs/runbook.md.
    user_data = base64encode(templatefile("${path.module}/cloud-init.yaml", {
      hostname   = var.duckdns_hostname
      acme_email = var.acme_email
      region     = var.region
      bucket     = oci_objectstorage_bucket.backups.name
      namespace  = data.oci_objectstorage_namespace.this.namespace
    }))
  }

  # An image update would otherwise destroy and recreate the instance, taking
  # the disk with it. Rebuilding is a deliberate act, not a side effect of
  # someone bumping a variable.
  #
  # Editing cloud-init.yaml *does* replace this instance, on purpose — a host
  # built by a script that has since changed is a host nobody can reason about.
  # Two things follow from that and are easy to forget until the site is down:
  # the public IP changes, so the DuckDNS record has to be repointed, and the
  # host is unreachable for the few minutes cloud-init takes. Nothing on the
  # disk matters — the data is in MySQL and the code is redeployed — which is
  # what makes the trade worth taking.
  lifecycle {
    ignore_changes = [source_details[0].source_id]
  }

  # The database takes several minutes longer than the instance. Ordering them
  # means the host is not up and answering before there is anything to answer
  # from.
  depends_on = [oci_mysql_mysql_db_system.vault]
}
