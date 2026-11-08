// The audit stream (B7): every admin audit record and organization event is
// also sent, as it happens, to AUDIT_WEBHOOK_URL — a SIEM, Splunk HEC, an
// Elastic or log-pipeline endpoint. Signed with AUDIT_WEBHOOK_SECRET when set.
// Best effort and off the request path: the audit log itself is the record.

import { createHmac } from 'node:crypto'

import type { App } from './context.js'

export interface StreamEvent {
  source: 'admin' | 'organization'
  at: string
  actor: string
  action: string
  target?: string
  orgId?: string
  collectionId?: string
  itemId?: string
  detail?: string
}

export function streamAudit(app: App, e: StreamEvent): void {
  const { url, secret } = app.config.auditWebhook
  if (!url) return
  const body = JSON.stringify({ service: 'vault', origin: app.config.origin, ...e })
  const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'vault-audit-stream' }
  if (secret) headers['x-vault-signature'] = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
  void fetch(url, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(5000) })
    .then((r) => { if (!r.ok) console.error('audit stream refused:', r.status) })
    .catch((err: unknown) => console.error('audit stream failed:', (err as Error).message))
}
