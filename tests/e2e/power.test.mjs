// Working faster (E4–E6): the command palette, single-key shortcuts, bulk
// actions on several items, and list order and density that follow the
// person to their next unlock.

import test from 'node:test'
import assert from 'node:assert/strict'

import { start } from './helpers.mjs'

async function add(page, name, password) {
  await page.click('.topbar .btn-primary')
  await page.fill('#f-name', name)
  if (password) await page.fill('#f-password', password)
  await page.click('.editor-foot .btn-primary')
  await page.waitForSelector(`.detail h2:has-text("${name}")`)
}

const names = async (page) => (await page.locator('.row-name').allTextContents()).map((s) => s.trim())

test('palette finds and opens an item, copies its password, and runs actions; shortcuts work', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await s.register(page, 'dev@example.test')
    await add(page, 'GitHub', 'octo-Cat-Rocket-Lime-9')
    await add(page, 'Gmail', 'blue-Whale-Paper-Moon-4')
    await page.keyboard.press('Escape')

    await page.keyboard.press('Control+k')
    await page.getByRole('combobox', { name: 'Search items and actions' }).fill('git')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.detail h2:has-text("GitHub")')

    await page.keyboard.press('Control+k')
    await page.getByRole('combobox', { name: 'Search items and actions' }).fill('gmail')
    await page.keyboard.press('Shift+Enter')
    await page.waitForSelector('text=Password for Gmail copied', { state: 'attached' })
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'blue-Whale-Paper-Moon-4')

    await page.keyboard.press('Control+k')
    await page.getByRole('combobox', { name: 'Search items and actions' }).fill('health')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.list-head h2:has-text("Password health")')

    // j/k walk the list; e edits; Escape backs out; n starts a new item; ? lists shortcuts.
    await page.locator('.sidebar').getByRole('button', { name: /All items/ }).click()
    await page.keyboard.press('j')
    await page.waitForSelector('.detail h2:has-text("GitHub")')
    await page.keyboard.press('j')
    await page.waitForSelector('.detail h2:has-text("Gmail")')
    await page.keyboard.press('k')
    await page.waitForSelector('.detail h2:has-text("GitHub")')
    await page.keyboard.press('e')
    await page.waitForSelector('#f-name')
    // Escape closes the editor once focus has left its fields (typing is never interrupted).
    await page.locator('#f-name').blur()
    await page.keyboard.press('Escape')
    await page.waitForSelector('#f-name', { state: 'detached' })
    await page.keyboard.press('n')
    await page.waitForSelector('h2:has-text("New item")')
    await page.locator('#f-name').blur()
    await page.keyboard.press('Escape')
    await page.keyboard.press('?')
    await page.waitForSelector('#ks-title')
    await page.getByRole('button', { name: 'Close' }).click()
    await page.keyboard.press('l')
    await page.waitForSelector('text=Unlock your vault')
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})

test('select several items: favorite, move to a folder, archive, delete', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await s.register(page, 'dev@example.test')
    for (const n of ['Alpha', 'Bravo', 'Charlie', 'Delta']) await add(page, n)
    await page.getByRole('button', { name: 'New folder', exact: true }).click()
    await page.fill('#fd-name', 'Work')
    await page.locator('.modal').getByRole('button', { name: 'Save' }).click()
    await page.waitForSelector('.folder-item:has-text("Work")')

    await page.locator('.sidebar').getByRole('button', { name: /All items/ }).click()
    await page.getByRole('button', { name: 'Select', exact: true }).click()
    await page.getByLabel('Select Alpha').check()
    await page.getByLabel('Select Bravo').check()
    await page.waitForSelector('text=2 selected')
    await page.locator('.bulk-bar').getByRole('button', { name: 'Favorite' }).click()
    await page.waitForSelector('text=2 items added to favorites', { state: 'attached' })
    assert.equal(await page.locator('.row-star').count(), 2)

    await page.getByRole('button', { name: 'Select', exact: true }).click()
    await page.getByLabel('Select Charlie').check()
    await page.getByLabel('Select Delta').check()
    await page.getByLabel('Move to folder').selectOption({ label: 'Work' })
    await page.waitForSelector('text=2 items moved to Work', { state: 'attached' })
    await page.locator('.folder-item', { hasText: 'Work' }).locator('.side-item').click()
    assert.deepEqual(await names(page), ['Charlie', 'Delta'])

    await page.getByRole('button', { name: 'Select', exact: true }).click()
    await page.getByLabel('Select all shown').check()
    await page.locator('.bulk-bar').getByRole('button', { name: 'Archive' }).click()
    await page.waitForSelector('text=2 items archived', { state: 'attached' })
    await page.locator('.sidebar').getByRole('button', { name: /^Archive/ }).click()
    assert.deepEqual(await names(page), ['Charlie', 'Delta'])

    await page.getByRole('button', { name: 'Select', exact: true }).click()
    await page.getByLabel('Select Delta').check()
    await page.locator('.bulk-bar').getByRole('button', { name: 'Delete' }).click()
    await page.locator('.bulk-bar').getByRole('button', { name: 'Delete permanently' }).click()
    await page.waitForSelector('text=1 item deleted', { state: 'attached' })
    assert.deepEqual(await names(page), ['Charlie'])
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})

test('sort and density are kept for the next unlock', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await s.register(page, 'dev@example.test')
    for (const n of ['Zebra', 'Apple', 'Mango']) await add(page, n)
    assert.deepEqual(await names(page), ['Apple', 'Mango', 'Zebra'])
    await page.getByLabel('Sort by').selectOption('updated')
    assert.deepEqual(await names(page), ['Mango', 'Apple', 'Zebra'])
    await page.getByRole('button', { name: 'Compact rows' }).click()
    await page.waitForSelector('.rows-compact')

    await page.reload()
    await s.unlock(page, 'dev@example.test')
    await page.waitForSelector('.rows-compact')
    assert.deepEqual(await names(page), ['Mango', 'Apple', 'Zebra'])
    assert.equal(await page.getByLabel('Sort by').inputValue(), 'updated')
  } finally {
    await s.stop()
  }
})
