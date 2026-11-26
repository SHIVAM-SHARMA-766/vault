variable "tenancy_ocid" {
  description = "Tenancy OCID. Also used as the root compartment."
  type        = string
}

variable "user_ocid" {
  description = "OCID of the user whose API key Terraform signs with."
  type        = string
}

variable "fingerprint" {
  description = "Fingerprint of that API key."
  type        = string
}

variable "private_key_path" {
  description = "Path to the API private key. Never committed."
  type        = string
  default     = "~/.oci/oci_api_key.pem"
}

variable "region" {
  description = "OCI region. Everything lives in one region; there is nothing to distribute."
  type        = string
  default     = "ap-mumbai-1"
}

variable "name_prefix" {
  description = "Prefix on every resource name, so this project's resources are obvious in a shared tenancy."
  type        = string
  default     = "vault"
}

variable "vcn_cidr" {
  description = <<-EOT
    Address range for this project's own network. Deliberately distinct from
    any other network in the tenancy: these resources share an account with
    other projects and must not share anything else.
  EOT
  type        = string
  default     = "10.20.0.0/24"
}

variable "ssh_public_key_path" {
  description = "Public key placed on the instance at first boot."
  type        = string
  default     = "~/.ssh/oci-vault.pub"
}

variable "ssh_allowed_cidr" {
  description = <<-EOT
    Where SSH may be reached from. Defaults to nowhere on purpose.

    The instance is administered through the OCI console's serial connection or
    by setting this to a single address when needed. Leaving SSH open to the
    whole internet on the host that serves a password manager is not a trade
    worth making for convenience.
  EOT
  type        = list(string)
  default     = []
}

variable "instance_shape" {
  description = <<-EOT
    Always-free shapes, which are not interchangeable:

      VM.Standard.E2.1.Micro   AMD, x86_64, 1 OCPU / 1 GB. Two per tenancy,
                               and generally available.
      VM.Standard.A1.Flex      Ampere, aarch64. A better machine, but capacity
                               in this region has been unobtainable — a
                               previous attempt ran 455 times over seven hours
                               without success.
  EOT
  type        = string
  default     = "VM.Standard.E2.1.Micro"
}

variable "instance_image_ocid" {
  description = <<-EOT
    Ubuntu image OCID for the chosen shape and region. Architecture must match:
    an aarch64 image will not boot on an AMD shape. Find the current one with

      oci compute image list --compartment-id <tenancy> \
        --operating-system "Canonical Ubuntu" --shape <shape> \
        --sort-by TIMECREATED --query 'data[0].id' --raw-output
  EOT
  type        = string
}

variable "duckdns_hostname" {
  description = <<-EOT
    The name the browser connects to, for example vault.dev2ops.in (any DNS name; the
    variable keeps its old name). Used by cloud-init on first boot only: changing it replaces
    the instance. To move a running host, see docs/runbook.md, "Changing the address".

    This is the whole of the user-facing trust path: whoever controls this name
    can obtain a certificate for it and serve their own JavaScript. See the
    accepted risks in docs/threat-model.md.
  EOT
  type        = string
}

variable "default_tags" {
  description = "Applied to every taggable resource, so this project's resources can be found and removed as a group."
  type        = map(string)
  default = {
    Project   = "vault"
    ManagedBy = "terraform"
  }
}

variable "nosql_read_units" {
  description = "Sustained reads per second. The always-free allowance works out to about 50."
  type        = number
  default     = 50
}

variable "nosql_write_units" {
  description = "Sustained writes per second. Same allowance as reads."
  type        = number
  default     = 50
}

variable "nosql_storage_gb" {
  description = "Table storage. The always-free allowance is 25 GB per table, three tables."
  type        = number
  default     = 25
}

variable "backup_retention_days" {
  description = "How long an encrypted export is kept before the lifecycle rule removes it."
  type        = number
  default     = 90
}

variable "acme_email" {
  description = "Address Let's Encrypt uses for expiry warnings. Not published anywhere."
  type        = string
}

variable "mysql_version" {
  description = <<-EOT
    MySQL version.

    Not a free choice. The always-free tier refuses anything but the newest
    release:

      400-InvalidParameter, attribute = {mysqlVersion} - Always Free Tier DB
      Systems must use the latest active available version 26.7.0

    An LTS family would be the better fit for something holding a password
    vault, since Innovation releases move faster than anything here needs to.
    The tier does not offer it. Because the tier also forces upgrades, the
    resource ignores changes to this value so that a new release does not
    destroy and recreate the system underneath the data.

    Find the current one with:
      oci mysql version list --compartment-id <tenancy>
  EOT
  type        = string
  default     = "26.7.0"
}

variable "mysql_storage_gb" {
  description = "Data storage. The always-free allowance is 50 GB, plus 50 GB of backup."
  type        = number
  default     = 50
}

variable "alert_emails" {
  description = "Addresses that receive alarm mails. Each gets a confirmation mail from OCI first; nothing arrives until its link is opened."
  type        = list(string)
  default     = []
}

variable "alert_https_endpoints" {
  description = "Optional HTTPS endpoints that receive alarms as a POST, e.g. an ntfy topic URL for phone push notifications."
  type        = list(string)
  default     = []
}
