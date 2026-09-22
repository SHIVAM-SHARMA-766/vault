# This project's own network.
#
# A separate VCN rather than a shared one, because the point of separation is
# that a rule added for something else cannot reach the host running the vault.

resource "oci_core_vcn" "this" {
  compartment_id = local.compartment_id
  display_name   = "${local.name}-vcn"
  cidr_blocks    = [var.vcn_cidr]
  dns_label      = "vault"
  freeform_tags  = var.default_tags
}

resource "oci_core_internet_gateway" "this" {
  compartment_id = local.compartment_id
  vcn_id         = oci_core_vcn.this.id
  display_name   = "${local.name}-igw"
  enabled        = true
  freeform_tags  = var.default_tags
}

resource "oci_core_route_table" "public" {
  compartment_id = local.compartment_id
  vcn_id         = oci_core_vcn.this.id
  display_name   = "${local.name}-public"

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.this.id
  }

  freeform_tags = var.default_tags
}

resource "oci_core_subnet" "public" {
  compartment_id    = local.compartment_id
  vcn_id            = oci_core_vcn.this.id
  display_name      = "${local.name}-public"
  cidr_block        = var.vcn_cidr
  route_table_id    = oci_core_route_table.public.id
  security_list_ids = [oci_core_vcn.this.default_security_list_id]
  dns_label         = "public"
  freeform_tags     = var.default_tags
}

resource "oci_core_network_security_group" "this" {
  compartment_id = local.compartment_id
  vcn_id         = oci_core_vcn.this.id
  display_name   = "${local.name}-nsg"
  freeform_tags  = var.default_tags
}

# HTTP exists only so that Caddy can answer the ACME challenge and redirect
# everything else to HTTPS. Nothing is ever served over it.
resource "oci_core_network_security_group_security_rule" "http" {
  network_security_group_id = oci_core_network_security_group.this.id
  direction                 = "INGRESS"
  protocol                  = "6"
  source                    = "0.0.0.0/0"
  source_type               = "CIDR_BLOCK"
  description               = "HTTP, for ACME challenges and the redirect to HTTPS."

  tcp_options {
    destination_port_range {
      min = 80
      max = 80
    }
  }
}

resource "oci_core_network_security_group_security_rule" "https" {
  network_security_group_id = oci_core_network_security_group.this.id
  direction                 = "INGRESS"
  protocol                  = "6"
  source                    = "0.0.0.0/0"
  source_type               = "CIDR_BLOCK"
  description               = "HTTPS. The vault."

  tcp_options {
    destination_port_range {
      min = 443
      max = 443
    }
  }
}

# Absent unless ssh_allowed_cidr is set, which it is not by default. An earlier
# network in this tenancy left SSH open to 0.0.0.0/0; that is not repeated
# here, on the host that serves a password manager least of all.
resource "oci_core_network_security_group_security_rule" "ssh" {
  for_each = toset(var.ssh_allowed_cidr)

  network_security_group_id = oci_core_network_security_group.this.id
  direction                 = "INGRESS"
  protocol                  = "6"
  source                    = each.value
  source_type               = "CIDR_BLOCK"
  description               = "SSH from ${each.value}."

  tcp_options {
    destination_port_range {
      min = 22
      max = 22
    }
  }
}

resource "oci_core_network_security_group_security_rule" "egress" {
  network_security_group_id = oci_core_network_security_group.this.id
  direction                 = "EGRESS"
  protocol                  = "all"
  destination               = "0.0.0.0/0"
  destination_type          = "CIDR_BLOCK"
  description               = "Outbound: Let's Encrypt, package updates, NoSQL, Object Storage."
}
