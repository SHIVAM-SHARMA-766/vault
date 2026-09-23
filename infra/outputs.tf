output "url" {
  description = "Where the vault is served."
  value       = "https://${var.duckdns_hostname}"
}

output "public_ip" {
  description = "The address the DuckDNS record must point at. Set it before the first boot, or the certificate cannot be issued."
  value       = oci_core_instance.vault.public_ip
}

output "instance_id" {
  description = "OCID of the host. The dynamic group matches this exactly."
  value       = oci_core_instance.vault.id
}

output "db_host" {
  description = "Private address of the database. Reachable only from inside this VCN."
  value       = oci_mysql_mysql_db_system.vault.ip_address
}

output "db_admin_user" {
  description = "Database user the API connects as."
  value       = "vault"
}

output "db_password" {
  description = <<-EOT
    Generated once and held in Terraform state. Read it with

      terraform output -raw db_password

    and install it into the host's secrets file as described in
    ../docs/runbook.md. It is deliberately not passed through instance
    metadata, which is readable by anything running on the host.
  EOT
  # Read from the generator rather than from the database resource: the API
  # does not return the password, so the resource's copy is empty after an
  # import.
  value     = random_password.db_admin.result
  sensitive = true
}

output "backup_bucket" {
  description = "Object Storage bucket encrypted exports are written to."
  value       = oci_objectstorage_bucket.backups.name
}

output "namespace" {
  description = "Object Storage namespace for this tenancy."
  value       = data.oci_objectstorage_namespace.this.namespace
}

output "ssh_command" {
  description = "Only works when ssh_allowed_cidr includes your address; it is empty by default."
  value       = "ssh -i ~/.ssh/oci-vault ubuntu@${oci_core_instance.vault.public_ip}"
}
