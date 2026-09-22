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

output "table_name" {
  description = "NoSQL table holding the vault."
  value       = oci_nosql_table.vault.name
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
