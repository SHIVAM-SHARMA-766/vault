// Mail through a real SMTP server that requires STARTTLS (when
// SMTP_TEST_HOST is set; CI runs Mailpit). Proves the transport settings in
// src/mail.ts — STARTTLS required, certificate verified — against a server,
// not a stand-in. The test CA is trusted through NODE_EXTRA_CA_CERTS.

import test from 'node:test'
import assert from 'node:assert/strict'

import { parseConfig } from '../src/config.js'
import { createMailer, inviteMessage } from '../src/mail.js'

const host = process.env['SMTP_TEST_HOST']
const api = process.env['SMTP_TEST_API'] // Mailpit's HTTP API, to read what arrived

test('an invitation is delivered over STARTTLS to a real SMTP server', { skip: !host }, async () => {
  const config = parseConfig({
    VAULT_HOSTNAME: 'vault.example', DB_DRIVER: 'sqlite', SERVER_PEPPER: 'p'.repeat(40), TOKEN_SIGNING_KEY: 'k'.repeat(40),
    SMTP_HOST: host, SMTP_PORT: process.env['SMTP_TEST_PORT'] ?? '587', SMTP_USER: 'vault', SMTP_PASSWORD: 'test', MAIL_FROM: 'Vault <vault@vault.example>',
  })
  const mailer = await createMailer(config)
  assert.ok(mailer)
  const to = `live-${Date.now()}@example.test`
  await mailer.send({ to, ...inviteMessage(config.origin, 'ABCD-EFGH-JKLM-NPQR-STUV-WXYZ', 'Live test', '2026-12-01T00:00:00Z') })
  if (!api) return
  const found = await fetch(`${api}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`).then((r) => r.json()) as { messages: { Subject: string }[] }
  assert.equal(found.messages.length, 1)
  assert.match(found.messages[0]!.Subject, /invited/)
})

test('a server that does not offer STARTTLS is refused, not used in plain text', { skip: !process.env['SMTP_TEST_PLAIN_PORT'] }, async () => {
  const config = parseConfig({
    VAULT_HOSTNAME: 'vault.example', DB_DRIVER: 'sqlite', SERVER_PEPPER: 'p'.repeat(40), TOKEN_SIGNING_KEY: 'k'.repeat(40),
    SMTP_HOST: host ?? '127.0.0.1', SMTP_PORT: process.env['SMTP_TEST_PLAIN_PORT']!, MAIL_FROM: 'Vault <vault@vault.example>',
  })
  const mailer = (await createMailer(config))!
  await assert.rejects(mailer.send({ to: 'x@example.test', subject: 's', text: 't' }))
})
