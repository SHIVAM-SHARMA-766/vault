// Admin operations: the sign-in allow-list (G2), rate limits in words (G5),
// editable email templates (G6), and server backups from the panel (C7).

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { takeBackupRequest } from '../src/backup.js'
import { parseConfig } from '../src/config.js'
import { allowedFrom, parseNetwork } from '../src/networks.js'
import { SqliteStore } from '../src/storage/sqlite.js'
import { fixtureB64, harness, registration } from './harness.js'

const POLICY = { requireTwoFactor: false, minPasswordScore: 0, maxIdleMinutes: null, sessionDays: null, activityDays: 90, auditDays: 365, shareLinks: true, shareLinkMaxDays: 30, allowedNetworks: [] as string[] }

async function setup(mail = false) {
  const h = harness({ adminEmails: ['owner@example.com'], allowRegistration: true, mail })
  const owner = (await h.request('POST', '/api/auth/register', { body: registration({ email: 'owner@example.com', authKey: fixtureB64('owner') }) })).body
  const user = (await h.request('POST', '/api/auth/register', { body: registration({ email: 'user@example.com', authKey: fixtureB64('user') }) })).body
  h.app.allowRegistration = false
  return { h, owner: String(owner['accessToken']), user: String(user['accessToken']), userRefresh: String(user['refreshToken']) }
}

const loginAs = (h: ReturnType<typeof harness>, who: 'owner' | 'user', ip: string) =>
  h.request('POST', '/api/auth/login', { ip, body: { email: `${who}@example.com`, authKey: fixtureB64(who) } })

// ── G2 ──────────────────────────────────────────────────────────────────────

test('networks parse as addresses or CIDR ranges, v4 and v6, and match', () => {
  assert.deepEqual(parseNetwork('203.0.113.0/24'), { address: '203.0.113.0', prefix: 24, family: 'ipv4' })
  assert.equal(parseNetwork('2001:db8::/32')?.family, 'ipv6')
  for (const bad of ['203.0.113.0/33', 'example.com', '10.0.0.1/8/1', '', '1.2.3.4/x']) assert.equal(parseNetwork(bad), null, bad)
  assert.equal(allowedFrom([], '198.51.100.1'), true, 'an empty list allows everyone')
  assert.equal(allowedFrom(['203.0.113.0/24'], '203.0.113.77'), true)
  assert.equal(allowedFrom(['203.0.113.0/24'], '::ffff:203.0.113.77'), true, 'IPv4-mapped IPv6 counts')
  assert.equal(allowedFrom(['203.0.113.0/24'], '198.51.100.1'), false)
  assert.equal(allowedFrom(['2001:db8::/32'], '2001:db8::5'), true)
})

test('outside the allow-list, a user cannot sign in or refresh; an owner still can', async () => {
  const { h, owner, userRefresh } = await setup()
  // The harness's default address is 203.0.113.7: the owner saves from inside.
  assert.equal((await h.request('PUT', '/api/admin/settings', { token: owner, body: { policy: { ...POLICY, allowedNetworks: ['203.0.113.0/24'] } } })).status, 200)
  assert.equal((await loginAs(h, 'user', '203.0.113.50')).status, 200)
  const outside = await loginAs(h, 'user', '198.51.100.9')
  assert.equal(outside.status, 403)
  assert.match(String(outside.body['message']), /not allowed/)
  assert.equal(outside.body['error'], 'network_not_allowed')
  assert.equal((await h.request('POST', '/api/auth/refresh', { ip: '198.51.100.9', body: { refreshToken: userRefresh } })).status, 403)
  assert.equal((await loginAs(h, 'owner', '198.51.100.9')).status, 200, 'owners are exempt, so a wrong list can be fixed')
})

test('a list that would shut out the admin saving it is refused; junk is refused', async () => {
  const { h, owner } = await setup()
  const res = await h.request('PUT', '/api/admin/settings', { token: owner, body: { policy: { ...POLICY, allowedNetworks: ['10.0.0.0/8'] } } })
  assert.equal(res.status, 400)
  assert.match(String(res.body['message']), /203\.0\.113\.7/)
  assert.equal((await h.request('PUT', '/api/admin/settings', { token: owner, body: { policy: { ...POLICY, allowedNetworks: ['not-a-network'] } } })).status, 400)
  assert.equal((await h.request('PUT', '/api/admin/settings', { token: owner, body: { policy: { ...POLICY, allowedNetworks: Array(51).fill('203.0.113.0/24') } } })).status, 400)
})

// ── G5 ──────────────────────────────────────────────────────────────────────

test('rate limits are listed in words for staff, and hidden from others', async () => {
  const { h, owner, user } = await setup()
  const res = await h.request('GET', '/api/admin/limits', { token: owner })
  const limits = res.body['limits'] as { name: string; max: number; windowSeconds: number }[]
  assert.ok(limits.find((l) => l.name === 'Sign-in attempts' && l.max === 10 && l.windowSeconds === 900))
  assert.ok(limits.length >= 8)
  assert.equal((await h.request('GET', '/api/admin/limits', { token: user })).status, 403)
})

// ── G6 ──────────────────────────────────────────────────────────────────────

test('an admin\'s subject and message go on invitations; the code and warnings stay', async () => {
  const { h, owner } = await setup(true)
  await h.request('PUT', '/api/admin/settings', { token: owner, body: { profile: { name: 'Acme Vault', supportEmail: '', supportUrl: '' } } })
  assert.equal((await h.request('PUT', '/api/admin/settings', { token: owner, body: { templates: { invite: { subject: 'Welcome to {server}', message: 'Hi! IT here.\nSet it up today.' } } } })).status, 200)
  await h.request('PUT', '/api/admin/settings', { token: owner, body: { registration: 'invite' } })
  assert.equal((await h.request('POST', '/api/admin/invites', { token: owner, body: { label: 'Asha', days: 7, email: 'asha@example.test' } })).status, 201)
  const sent = h.outbox.at(-1)!
  assert.equal(sent.subject, 'Welcome to Acme Vault')
  assert.match(sent.text, /^Hi! IT here\.\nSet it up today\.\n\n/)
  assert.match(sent.text, /\?invite=/, 'the link is still there')
  assert.match(sent.text, /nobody, including the people running this server, can reset it/)
})

test('templates are validated, previewed, and cleared back to the default', async () => {
  const { h, owner } = await setup(true)
  for (const bad of [{ nope: { subject: 'x', message: '' } }, { invite: { subject: 'two\nlines', message: '' } }, { invite: { subject: 'x'.repeat(121), message: '' } }, { signIn: { subject: '', message: 'y'.repeat(1001) } }]) {
    assert.equal((await h.request('PUT', '/api/admin/settings', { token: owner, body: { templates: bad } })).status, 400, JSON.stringify(bad).slice(0, 40))
  }
  const preview = await h.request('POST', '/api/admin/templates/preview', { token: owner, body: { kind: 'signIn', subject: 'Sign-in at {server}', message: 'From IT.' } })
  assert.equal(preview.body['subject'], 'Sign-in at Vault')
  assert.match(String(preview.body['text']), /^From IT\.\n\nYour Vault account was signed in/)
  await h.request('PUT', '/api/admin/settings', { token: owner, body: { templates: { signIn: { subject: 'Custom', message: '' } } } })
  await h.request('PUT', '/api/admin/settings', { token: owner, body: { templates: { signIn: { subject: '', message: '' } } } })
  assert.deepEqual((await h.request('GET', '/api/admin/settings', { token: owner })).body['templates'], {})
  await loginAs(h, 'user', '203.0.113.7')
  assert.match(h.outbox.at(-1)!.subject, /New sign-in/)
})

// ── C7 ──────────────────────────────────────────────────────────────────────

test('backup status shows the host settings; "back up now" needs backups set up', async () => {
  const { h, owner, user } = await setup()
  const off = (await h.request('GET', '/api/admin/backup', { token: owner })).body
  assert.equal(off['enabled'], false)
  assert.equal((await h.request('POST', '/api/admin/backup/run', { token: owner })).status, 503)
  h.app.config.backup = { ...h.app.config.backup, passphrase: 'correct horse battery staple 42', dir: '/srv/backups' }
  const on = (await h.request('GET', '/api/admin/backup', { token: owner })).body
  assert.equal(on['enabled'], true)
  assert.deepEqual(on['destinations'], [{ kind: 'directory', where: '/srv/backups' }])
  assert.ok(!JSON.stringify(on).includes('correct horse'), 'the passphrase never leaves the host')
  assert.equal((await h.request('POST', '/api/admin/backup/run', { token: user })).status, 403)
  const req = await h.request('POST', '/api/admin/backup/run', { token: owner })
  assert.equal(req.status, 202)
  assert.ok((await h.request('GET', '/api/admin/backup', { token: owner })).body['requestedAt'])
  const audit = (await h.request('GET', '/api/admin/audit', { token: owner })).body['records'] as { action: string }[]
  assert.ok(audit.some((r) => r.action === 'backup.request'))
})

test('the server\'s loop takes a backup request once, and writes the file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vault-bknow-'))
  try {
    const store = await SqliteStore.open(join(dir, 'v.db'))
    await store.migrate()
    const config = parseConfig({ VAULT_HOSTNAME: 'v.example', DB_DRIVER: 'sqlite', DB_PATH: join(dir, 'v.db'), SERVER_PEPPER: 'p'.repeat(44), TOKEN_SIGNING_KEY: 'k'.repeat(64), BACKUP_PASSPHRASE: 'correct horse battery staple 42', BACKUP_DIR: join(dir, 'b') })
    assert.equal(await takeBackupRequest(store, config), null, 'nothing asked, nothing done')
    await store.put({ pk: 'SYSTEM', sk: 'BACKUPREQ', at: new Date().toISOString(), by: 'u' })
    assert.ok(await takeBackupRequest(store, config))
    assert.equal(readdirSync(join(dir, 'b')).length, 1)
    assert.equal(await takeBackupRequest(store, config), null, 'taken once')
    await store.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
