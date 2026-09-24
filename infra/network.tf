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

# The subnet's security list, managed in place.
#
# Network security groups cover the instance, but a MySQL DB system is not in
# one — it takes the subnet's security list instead. The VCN's default list
# allows SSH from anywhere and nothing on 3306, so the database was unreachable
# from the host sharing its subnet while the host itself was wide open. Both
# halves of that are wrong.
#
# Managing the default rather than attaching a new list is deliberate: changing
# a subnet's security_list_ids replaces the subnet, which would cascade to the
# instance and the database.
resource "oci_core_default_security_list" "this" {
  manage_default_resource_id = oci_core_vcn.this.default_security_list_id
  display_name               = "${local.name}-default"

  egress_security_rules {
    destination      = "0.0.0.0/0"
    destination_type = "CIDR_BLOCK"
    protocol         = "all"
    description      = "Outbound: ACME, package updates, Object Storage."
  }

  # Only from inside this VCN, which contains the vault host and its database
  # and nothing else.
  ingress_security_rules {
    protocol    = "6"
    source      = var.vcn_cidr
    source_type = "CIDR_BLOCK"
    description = "MySQL, from the host that shares this network."

    tcp_options {
      min = 3306
      max = 3306
    }
  }

  # MySQL X Protocol, on the port the DB system also listens on.
  ingress_security_rules {
    protocol    = "6"
    source      = var.vcn_cidr
    source_type = "CIDR_BLOCK"
    description = "MySQL X Protocol."

    tcp_options {
      min = 33060
      max = 33060
    }
  }

  # Path MTU discovery. Dropping this is how a network starts blackholing large
  # responses for no visible reason.
  ingress_security_rules {
    protocol    = "1"
    source      = "0.0.0.0/0"
    source_type = "CIDR_BLOCK"
    description = "ICMP fragmentation-needed, for path MTU discovery."

    icmp_options {
      type = 3
      code = 4
    }
  }

  # Deliberately no SSH rule. The default list allowed it from anywhere; the
  # instance's network security group is where that decision belongs, and it
  # grants SSH to one address only when ssh_allowed_cidr is set.
}
