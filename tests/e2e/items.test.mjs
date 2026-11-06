// Phase 1 step 4: folders, type-specific fields, custom fields, and password
// history with restore — through the real client and API.

import test from 'node:test'
import assert from 'node:assert/strict'

import { start } from './helpers.mjs'

async function newFolder(page, name, parent) {
  if (parent) {
    await page.locator('.folder-item', { hasText: parent }).hover()
    await page.getByRole('button', { name: `New folder inside ${parent}` }).click()
  } else {
    await page.getByRole('button', { name: 'New folder', exact: true }).click()
  }
  await page.fill('#fd-name', name)
  await page.locator('.modal').getByRole('button', { name: 'Save' }).click()
  await page.waitForSelector(`.folder-item:has-text("${name}")`)
}

test('folders nest, hold entries, and deleting one moves its contents up', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await s.register(page, 'hana@example.test')
    await newFolder(page, 'Work')
    await newFolder(page, 'Servers', 'Work')

    // A new item started inside a folder lands in it.
    await page.locator('.folder-item', { hasText: 'Servers' }).locator('.side-item').click()
    await page.click('.topbar .btn-primary')
    assert.equal(await page.inputValue('#f-folder') !== '', true)
    await page.fill('#f-name', 'Prod DB')
    await page.fill('#f-username', 'admin')
    await page.click('.editor-foot .btn-primary')
    await page.waitForSelector('.badge-folder:has-text("Work / Servers")')

    // The parent folder's view includes what is beneath it.
    await page.locator('.folder-item', { hasText: 'Work' }).first().locator('.side-item').click()
    await page.waitForSelector('.row-item:has-text("Prod DB")')

    // Search finds it by folder name.
    await page.getByRole('button', { name: 'All items' }).click()
    await page.fill('input[type=search]', 'servers')
    await page.waitForSelector('.row-item:has-text("Prod DB")')
    await page.fill('input[type=search]', '')

    // Deleting Servers moves the entry up to Work.
    await page.locator('.folder-item', { hasText: 'Servers' }).hover()
    await page.getByRole('button', { name: 'Delete Servers' }).click()
    await page.getByRole('button', { name: 'Delete folder' }).click()
    await page.waitForSelector('.folder-item:has-text("Servers")', { state: 'detached' })
    await page.locator('.row-item', { hasText: 'Prod DB' }).click()
    await page.waitForSelector('.badge-folder:has-text("Work")')
    assert.equal(await page.textContent('.badge-folder'), 'Work')
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})

test('a card has card fields, shown masked with its brand', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await s.register(page, 'ivan@example.test')
    await page.click('.topbar .btn-primary')
    await page.selectOption('#f-type', 'card')
    await page.fill('#f-name', 'Travel card')
    await page.fill('#f-cardholder', 'IVAN TEST')
    await page.fill('#f-number', '4111111111111111')
    await page.fill('#f-expiry', '0929')
    assert.equal(await page.inputValue('#f-expiry'), '09/29')
    await page.fill('#f-cvv', '123')
    await page.click('.editor-foot .btn-primary')
    await page.waitForSelector('.detail-head')
    assert.match(await page.textContent('.row-item.row-active .row-meta'), /Visa •••• 1111/)
    const fields = await page.textContent('.fields')
    assert.ok(!fields.includes('4111'), 'the number is masked until revealed')
    await page.getByRole('button', { name: 'Reveal Card number' }).click()
    assert.ok((await page.textContent('.fields')).includes('4111 1111 1111 1111'))
  } finally {
    await s.stop()
  }
})

test('custom fields can be hidden, and edits keep a history that can be restored', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await s.register(page, 'jade@example.test')
    await page.click('.topbar .btn-primary')
    await page.fill('#f-name', 'Router')
    await page.fill('#f-password', 'first-password')
    await page.getByRole('button', { name: 'Add field' }).click()
    await page.fill('[aria-label="Custom field 1 name"]', 'Admin PIN')
    await page.fill('[aria-label="Custom field 1 value"]', '4321')
    await page.getByRole('button', { name: 'Hide custom field 1' }).click()
    await page.click('.editor-foot .btn-primary')
    await page.waitForSelector('.detail-head')
    assert.ok(!(await page.textContent('.fields')).includes('4321'), 'a hidden custom field is masked')

    // Change the password; the old one goes to history.
    await page.getByRole('button', { name: 'Edit' }).click()
    await page.fill('#f-password', 'second-password')
    await page.click('.editor-foot .btn-primary')
    await page.waitForSelector('.detail-head')
    await page.getByRole('button', { name: 'History' }).click()
    await page.waitForSelector('.history-row')
    assert.match(await page.textContent('.history-row'), /password/)
    await page.click('.history-row')
    await page.getByRole('button', { name: 'Reveal Password then' }).click()
    assert.ok((await page.textContent('.history-body')).includes('first-password'))

    await page.getByRole('button', { name: 'Restore this version' }).click()
    await page.waitForSelector('text=Version restored')
    await page.getByRole('button', { name: 'Reveal Password' }).first().click()
    await page.waitForFunction(() => document.querySelector('.fields')?.textContent?.includes('first-password'))
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})
