# Monitoring and alerting, on OCI's always-free Monitoring and Notifications.
#
# The host runs a probe every five minutes (services/monitor/vault-probe.sh)
# that checks the service from the outside in — the public site, the client,
# the API, the certificate — and the host from the inside — disk, memory, the
# last verified backup, failed units — and posts each as a custom metric in
# the `vault_health` namespace. The alarms below watch those metrics and mail
# the operator through a Notifications topic.
#
# A host that is down cannot report that it is down. The heartbeat alarm
# covers it: when the probe's metrics stop arriving, for any reason — the
# instance was stopped, reclaimed, or wedged, or the probe broke — the alarm
# fires on their absence.
#
# Cost: about ten metrics at one point every five minutes is under 100,000
# datapoints a month against an always-free allowance of 500 million; alarm
# mails come out of the 1,000 free emails a month, and repeats are throttled.

locals {
  health_ns = "vault_health"
  # Every alarm's notification says what to do, not just what happened.
  runbook = "Runbook: docs/runbook.md, section \"Alerts\"."
}

resource "oci_ons_notification_topic" "alerts" {
  compartment_id = local.compartment_id
  name           = "${local.name}-alerts"
  description    = "Where the vault's alarms are delivered."
  freeform_tags  = var.default_tags
}

# Email reaches a phone through the mail app; nothing to install. OCI sends a
# confirmation mail first, and nothing is delivered until its link is opened.
resource "oci_ons_subscription" "email" {
  for_each       = toset(var.alert_emails)
  compartment_id = local.compartment_id
  topic_id       = oci_ons_notification_topic.alerts.id
  protocol       = "EMAIL"
  endpoint       = each.value
  freeform_tags  = var.default_tags
}

# Optional push notifications: any HTTPS endpoint that accepts a POST, such as
# an ntfy topic URL. Empty by default.
resource "oci_ons_subscription" "push" {
  for_each       = toset(var.alert_https_endpoints)
  compartment_id = local.compartment_id
  topic_id       = oci_ons_notification_topic.alerts.id
  protocol       = "CUSTOM_HTTPS"
  endpoint       = each.value
  freeform_tags  = var.default_tags
}

locals {
  # name => [severity, query, pending duration, body]
  alarms = {
    heartbeat = ["CRITICAL", "api_up[5m].absent()", "PT10M",
    "No health report from the vault host for 10 minutes. The instance is stopped, reclaimed or hung, or the probe has stopped. Check the instance state in the OCI console first."]
    api_down = ["CRITICAL", "api_up[5m].max() < 1", "PT10M",
    "The API has failed its health check from the host for 10 minutes. Sign-in and the vault do not work. Look at: journalctl -u vault-api -n 100"]
    site_down = ["CRITICAL", "site_up[5m].max() < 1", "PT10M",
    "The public website or the web client has not answered with 200 for 10 minutes. Check Caddy (journalctl -u caddy) and the DuckDNS record."]
    certificate = ["WARNING", "cert_days_left[1h].min() < 14", "PT1H",
    "The TLS certificate expires in under 14 days and has not renewed. Caddy renews at 30 days left, so renewal is failing: journalctl -u caddy | grep -i acme"]
    backup_stale = ["CRITICAL", "backup_age_hours[1h].max() > 30", "PT1H",
    "No verified backup in over 30 hours. The daily export is the only backup there is. Look at: journalctl -u vault-backup -n 100"]
    restore_drill = ["INFO", "restore_drill_age_days[1h].min() > 95", "PT1H",
    "A restore drill is due (quarterly). On the host: sudo vault-restore-drill.sh — it restores the newest backup into a scratch database and compares it with the live one."]
    disk = ["WARNING", "disk_used_percent[15m].max() > 85", "PT30M",
    "The boot disk is over 85% full. Look at journald size and old releases under /srv/vault."]
    memory = ["WARNING", "memory_used_percent[15m].min() > 90", "PT30M",
    "Memory has stayed above 90% for 30 minutes. The micro instance has 1 GB; check what is using it with: ps aux --sort=-rss | head"]
    units_failed = ["WARNING", "failed_units[5m].max() > 0", "PT10M",
    "A vault systemd unit is in the failed state (API, backup, release pull or Caddy). See: systemctl --failed"]
  }
}

resource "oci_monitoring_alarm" "health" {
  for_each              = local.alarms
  compartment_id        = local.compartment_id
  metric_compartment_id = local.compartment_id
  display_name          = "${local.name}-${replace(each.key, "_", "-")}"
  namespace             = local.health_ns
  query                 = each.value[1]
  severity              = each.value[0]
  pending_duration      = each.value[2]
  body                  = "${each.value[3]} ${local.runbook}"
  destinations          = [oci_ons_notification_topic.alerts.id]
  is_enabled            = true
  # One reminder every six hours while it stays broken, not one every minute.
  repeat_notification_duration = "PT6H"
  message_format               = "ONS_OPTIMIZED"
  freeform_tags                = var.default_tags
}
