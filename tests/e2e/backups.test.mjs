// Personal backups, end to end: back up now, test restore, download a copy,
// restore it through Import & export, a schedule, and the old master password
// still opening a backup made before a password change.

import test from 'node:test'
import assert from 'node:assert/strict'

import { PASSWORD, start } from './helpers.mjs'

const NEW_PASSWORD = 'a completely different long passphrase'

async function addLogin(page, name, password) {
  await page.click('.topbar .btn-primary')
  await page.fill('#f-name', name)
  await page.fill('#f-password', password)
  await page.click('.editor-foot .btn-primary')
  await page.waitForSelector(`.detail h2:has-text("${name}")`)
}

async function backUpNow(page) {
  await page.getByRole('button', { name: 'Back up now' }).click()
  await page.waitForSelector('text=Backed up 1 item')
  await page.waitForSelector('.backup-runs li')
}

async function testRestore(page, secret) {
  if (await page.getByRole('button', { name: 'Test restore…' }).count()) await page.getByRole('button', { name: 'Test restore…' }).click()
  await page.fill('#b-test-secret', secret)
  await page.getByRole('button', { name: 'Test', exact: true }).click()
  await page.waitForSelector('.test-restore .alert', { timeout: 60_000 })
  return page.textContent('.test-restore .alert')
}

test('back up now, prove it opens, download it, and restore a deleted item from it', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await s.register(page, 'bea@example.test')
    await addLogin(page, 'Electricity board', 'kWh-2026-secret')
    await s.settings(page, 'Backups')
    assert.ok(page.url().endsWith('/app/settings/backups'))
    await page.waitForSelector('text=Last backup')
    await backUpNow(page)
    assert.match(await page.textContent('.backup-runs'), /Backed up .* On this server .* 1 items/)

    assert.match(await testRestore(page, 'not the password at all'), /does not open the newest backup/)
    assert.match(await testRestore(page, PASSWORD), /opens: 1 item and 0 folders\. Nothing was imported\./)

    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#b-copies ~ * , section[aria-labelledby="b-copies"]').getByRole('button', { name: 'Download' }).first().click()])
    const chunks = []
    for await (const c of await download.createReadStream()) chunks.push(c)
    const file = Buffer.concat(chunks)
    assert.match(download.suggestedFilename(), /^vault-backup-\d{8}-\d{6}\.json$/)
    assert.ok(!file.toString().includes('kWh-2026-secret'), 'the backup holds no plaintext')

    // Lose the item, then bring it back from the backup.
    await s.menu(page, 'Vault')
    await page.locator('.row-item', { hasText: 'Electricity board' }).click()
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await page.getByRole('button', { name: 'Delete permanently' }).click()
    await page.waitForFunction(() => !document.querySelector('.row-item'))

    await s.menu(page, 'Import & export')
    await page.setInputFiles('.file-drop input', { name: download.suggestedFilename(), mimeType: 'application/json', buffer: file })
    await page.waitForSelector('text=is a Vault personal backup')
    await page.fill('#imp-pw', 'wrong password entirely')
    await page.getByRole('button', { name: 'Open backup' }).click()
    await page.waitForSelector('text=does not open this backup', { timeout: 60_000 })
    await page.fill('#imp-pw', PASSWORD)
    await page.getByRole('button', { name: 'Open backup' }).click()
    await page.waitForSelector('text=Vault personal backup (', { timeout: 60_000 })
    await page.getByRole('button', { name: /^Import 1 item/ }).click()
    await page.waitForSelector('.alert-ok')
    await s.menu(page, 'Vault')
    await page.locator('.row-item', { hasText: 'Electricity board' }).click()
    await page.waitForSelector('.detail h2:has-text("Electricity board")')
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})

test('a schedule shows when the next backup runs; turning it off clears it', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await s.register(page, 'cyd@example.test')
    await s.settings(page, 'Backups')
    await page.waitForSelector('#b-freq')
    await page.selectOption('#b-freq', 'weekly')
    await page.selectOption('#b-day', '1')
    await page.selectOption('#b-hour', '3')
    await page.selectOption('#b-keep', '5')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.waitForSelector('text=Backup settings saved')
    const next = await page.locator('.facts div', { hasText: 'Next backup' }).locator('dd').textContent()
    assert.notEqual(next, 'Not scheduled')
    assert.match(next, /Mon|3/)

    // It stays after a reload.
    await page.reload()
    await s.unlock(page, 'cyd@example.test')
    await page.waitForSelector('#b-freq')
    assert.equal(await page.inputValue('#b-freq'), 'weekly')
    assert.equal(await page.inputValue('#b-keep'), '5')

    await page.selectOption('#b-freq', 'off')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.waitForSelector('text=Backup settings saved')
    await page.waitForSelector('.facts dd:has-text("Not scheduled")')
  } finally {
    await s.stop()
  }
})

test('a backup made before a password change opens with the old password, and with the recovery key', async () => {
  const s = await start()
  try {
    const page = await s.person()
    const recoveryKey = await s.register(page, 'dev@example.test')
    await addLogin(page, 'Router admin', 'r0uter-pass')
    await s.settings(page, 'Backups')
    await backUpNow(page)

    await s.settings(page, 'Account')
    await page.fill('#cp-current', PASSWORD)
    await page.fill('#cp-new', NEW_PASSWORD)
    await page.fill('#cp-confirm', NEW_PASSWORD)
    await page.getByRole('button', { name: 'Change master password' }).click()
    await page.waitForSelector('text=Master password changed', { timeout: 60_000 })

    await s.settings(page, 'Backups')
    assert.match(await testRestore(page, NEW_PASSWORD), /needs the one you had when the backup was made/)
    assert.match(await testRestore(page, PASSWORD), /opens: 1 item/)
    await page.getByText('Use the recovery key instead').click()
    assert.match(await testRestore(page, recoveryKey), /opens: 1 item/)
  } finally {
    await s.stop()
  }
})
