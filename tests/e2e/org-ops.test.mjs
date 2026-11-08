// Operations: an organization backup that restores through Import & export
// (C6), and the audit log downloaded as CSV and JSON (B7).

import test from 'node:test'
import assert from 'node:assert/strict'

import { start } from './helpers.mjs'

test('an organization backup opens in Import & export, each collection a folder', async () => {
  const s = await start({ owner: 'alice@example.test' })
  try {
    const alice = await s.person()
    await s.register(alice, 'alice@example.test')
    await s.menu(alice, 'Organizations')
    await alice.fill('#o-name', 'Acme')
    await alice.getByRole('button', { name: 'Create', exact: true }).click()
    // The organization's recovery key is shown once (decisions/0026).
    await alice.waitForSelector('#ork-title')
    await alice.getByLabel('I have stored it somewhere safe').check()
    await alice.getByRole('button', { name: 'Done' }).click()
    await alice.waitForSelector('.org-card h2:has-text("Acme")')
    await alice.fill('input[aria-label="New collection name"]', 'Finance')
    await alice.getByRole('button', { name: 'Add collection' }).click()
    await alice.waitForSelector('.collection-row:has-text("Finance")')

    await s.menu(alice, 'Vault')
    await alice.click('.topbar .btn-primary')
    await alice.fill('#f-name', 'Payroll')
    await alice.fill('#f-password', 'ledger-Quartz-Harbor-Pencil-8')
    await alice.click('.editor-foot .btn-primary')
    await alice.waitForSelector('.detail h2:has-text("Payroll")')
    await alice.locator('.detail-actions').getByRole('button', { name: 'Share', exact: true }).click()
    await alice.selectOption('select[aria-label="Collection"]', { label: 'Acme / Finance' })
    await alice.getByRole('button', { name: 'Move to collection' }).click()
    await alice.waitForSelector('.badge-shared:has-text("Acme / Finance")')

    await s.menu(alice, 'Organizations')
    await alice.getByRole('button', { name: 'Back up this organization…' }).click()
    await alice.waitForSelector('text=1 item in 1 collection')
    await alice.getByLabel('Backup password', { exact: true }).fill('an organization backup password')
    await alice.getByLabel('Backup password again').fill('an organization backup password')
    const [file] = await Promise.all([alice.waitForEvent('download'), alice.getByRole('button', { name: 'Download backup' }).click()])
    assert.match(file.suggestedFilename(), /^vault-org-acme-\d{4}-\d{2}-\d{2}\.json$/)
    const text = await (await file.createReadStream()).toArray().then((c) => Buffer.concat(c).toString('utf8'))
    assert.ok(!text.includes('ledger-Quartz'), 'the file is encrypted')

    // Restore into another account: the collection is a folder under the organization.
    await s.setRegistration(true)
    const other = await s.person()
    await s.register(other, 'restore@example.test')
    await s.menu(other, 'Import & export')
    await other.setInputFiles('.file-drop input', { name: file.suggestedFilename(), mimeType: 'application/json', buffer: Buffer.from(text) })
    await other.fill('#imp-pw', 'an organization backup password')
    await other.getByRole('button', { name: 'Open export' }).click()
    await other.getByRole('button', { name: 'Import 1 item' }).click()
    await other.waitForSelector('.alert-ok:has-text("Imported 1 item")')
    await other.getByRole('link', { name: 'Go to the vault' }).click()
    await other.locator('.row-item', { hasText: 'Payroll' }).click()
    await other.waitForSelector('.badge-folder:has-text("Acme / Finance")')
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})

test('the audit log downloads as CSV and JSON', async () => {
  const s = await start()
  try {
    const owner = await s.person()
    await s.register(owner, 'owner@example.test')
    await s.setRegistration(false)
    await s.menu(owner, 'Admin panel')
    await owner.getByRole('radio', { name: 'Invite only' }).click()
    await owner.waitForSelector('text=Registration is now invite', { state: 'attached' })
    await owner.locator('.sidebar .side-item', { hasText: 'Audit log' }).click()
    const [csv] = await Promise.all([owner.waitForEvent('download'), owner.getByRole('button', { name: 'CSV' }).click()])
    const csvText = await (await csv.createReadStream()).toArray().then((c) => Buffer.concat(c).toString('utf8'))
    assert.match(csvText.split(/\r?\n/)[0], /^at,actor,actorLabel,action,target,targetLabel,detail$/)
    assert.match(csvText, /settings\.registration/)
    const [json] = await Promise.all([owner.waitForEvent('download'), owner.getByRole('button', { name: 'JSON' }).click()])
    const parsed = JSON.parse(await (await json.createReadStream()).toArray().then((c) => Buffer.concat(c).toString('utf8')))
    assert.ok(parsed.records.some((r) => r.action === 'settings.registration'))
  } finally {
    await s.stop()
  }
})
