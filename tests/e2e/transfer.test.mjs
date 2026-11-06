// Phase 1 step 5: importing other managers' files, skipping duplicates, the
// encrypted export round trip between two accounts, and the CSV export behind
// the master password — through the real client and API.

import test from 'node:test'
import assert from 'node:assert/strict'

import { PASSWORD, start } from './helpers.mjs'

const CHROME = 'name,url,username,password,note\nGitHub,https://github.com/login,hana@example.test,gh-pass-1,\nBank,https://bank.example,cust42,bank-pass-2,branch 7\n'
const BITWARDEN = JSON.stringify({
  encrypted: false,
  folders: [{ id: 'f1', name: 'Work/Servers' }],
  items: [
    { type: 1, name: 'Prod DB', folderId: 'f1', login: { username: 'admin', password: 'db-pass-3', uris: [{ uri: 'https://db.example' }] } },
    { type: 3, name: 'Visa', card: { cardholderName: 'Hana', number: '4111111111111111', expMonth: '4', expYear: '2030', code: '321' } },
  ],
})

async function pickFile(page, name, text, mimeType) {
  await page.setInputFiles('.file-drop input', { name, mimeType, buffer: Buffer.from(text) })
}

async function importFile(page, name, text, mimeType = 'text/csv') {
  await pickFile(page, name, text, mimeType)
  return confirmImport(page)
}

async function confirmImport(page) {
  await page.waitForSelector('text=was read as')
  await page.getByRole('button', { name: /^Import \d+ item/ }).click()
  await page.waitForSelector('.alert-ok')
  return page.textContent('.alert-ok')
}

async function downloadText(page, click) {
  const [download] = await Promise.all([page.waitForEvent('download'), click()])
  const chunks = []
  for await (const c of await download.createReadStream()) chunks.push(c)
  return { name: download.suggestedFilename(), text: Buffer.concat(chunks).toString('utf8') }
}

test('imports from other managers, skips duplicates, and round-trips an encrypted export', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await s.register(page, 'hana@example.test')

    // The empty vault points at import.
    await page.getByRole('link', { name: 'Import from another password manager' }).click()
    await page.waitForSelector('h1:has-text("Import & export")')

    // Chrome CSV: format detected, both items imported.
    await pickFile(page, 'Chrome Passwords.csv', CHROME, 'text/csv')
    await page.waitForSelector('text=Chrome, Edge or Brave')
    assert.match(await confirmImport(page), /Imported 2 items/)

    // Importing the same file again finds both as duplicates.
    await page.getByRole('button', { name: 'Import another file' }).click()
    await pickFile(page, 'Chrome Passwords.csv', CHROME, 'text/csv')
    await page.waitForSelector('text=— 2 found')
    assert.equal(await page.getByRole('button', { name: /^Import 0 items/ }).isDisabled(), true)
    await page.getByRole('button', { name: 'Cancel' }).click()

    // Bitwarden JSON: nested folders and a card.
    assert.match(await importFile(page, 'bitwarden.json', BITWARDEN, 'application/json'), /Imported 2 items/)

    await page.getByRole('link', { name: 'Go to the vault' }).click()
    await page.waitForSelector('.row-item:has-text("Prod DB")')
    await page.locator('.row-item', { hasText: 'Prod DB' }).click()
    await page.waitForSelector('.badge-folder:has-text("Work / Servers")')
    await page.locator('.row-item', { hasText: 'Visa' }).click()
    await page.waitForSelector('.detail .badge:has-text("Card")')
    assert.equal(await page.locator('.row-item').count(), 4)

    // Encrypted export.
    await s.menu(page, 'Import & export')
    await page.fill('#ex-pw', 'an export password here')
    await page.fill('#ex-confirm', 'an export password here')
    const exp = await downloadText(page, () => page.getByRole('button', { name: 'Export 4 items' }).click())
    assert.match(exp.name, /^vault-export-\d{4}-\d{2}-\d{2}\.json$/)
    assert.equal(JSON.parse(exp.text).format, 'vault-export')
    assert.equal(exp.text.includes('gh-pass-1'), false, 'the export is encrypted')

    // CSV export: refused with the wrong master password, then works.
    await page.fill('#csv-pw', 'not the password')
    await page.check('form[aria-labelledby=s-csv] .check input')
    await page.getByRole('button', { name: 'Download CSV' }).click()
    await page.waitForSelector('text=That master password is wrong.')
    await page.fill('#csv-pw', PASSWORD)
    const csv = await downloadText(page, () => page.getByRole('button', { name: 'Download CSV' }).click())
    assert.ok(csv.text.startsWith('folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp'))
    assert.ok(csv.text.includes('gh-pass-1'))
    assert.ok(csv.text.includes('Work/Servers,,login,Prod DB'))

    // A second account imports the encrypted export with its password.
    const other = await s.person()
    await s.register(other, 'ivan@example.test')
    await s.menu(other, 'Import & export')
    await pickFile(other, exp.name, exp.text, 'application/json')
    await other.fill('#imp-pw', 'the wrong export password')
    await other.getByRole('button', { name: 'Open export' }).click()
    await other.waitForSelector('text=That export password is wrong')
    await other.fill('#imp-pw', 'an export password here')
    await other.getByRole('button', { name: 'Open export' }).click()
    await other.waitForSelector('text=Vault (encrypted export)')
    await other.getByRole('button', { name: 'Import 4 items' }).click()
    await other.waitForSelector('.alert-ok:has-text("Imported 4 items")')
    await other.getByRole('link', { name: 'Go to the vault' }).click()
    await other.locator('.row-item', { hasText: 'Prod DB' }).click()
    await other.waitForSelector('.badge-folder:has-text("Work / Servers")')
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})
