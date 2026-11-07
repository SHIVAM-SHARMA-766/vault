// The archive: out of lists, counts, search and the health check; back with
// one click; and the flag travels encrypted.

import test from 'node:test'
import assert from 'node:assert/strict'

import { start } from './helpers.mjs'

async function add(page, name, password) {
  await page.click('.topbar .btn-primary')
  await page.fill('#f-name', name)
  await page.fill('#f-password', password)
  await page.click('.editor-foot .btn-primary')
  await page.waitForSelector(`.detail h2:has-text("${name}")`)
}

test('archive an item, find it only in the Archive, and restore it', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await s.register(page, 'arc@example.test')
    await add(page, 'Old router', 'weak')
    await add(page, 'Bank', 'a-long-strong-and-unique-password-1')

    await page.locator('.row-item', { hasText: 'Old router' }).click()
    await page.locator('.detail-actions').getByRole('button', { name: 'Archive', exact: true }).click()
    await page.waitForSelector('text=Archived')
    assert.deepEqual(await page.locator('.row-item .row-name').allTextContents(), ['Bank'])
    // The weak password no longer counts against health.
    await page.locator('.sidebar .side-item', { hasText: 'Password health' }).click()
    await page.waitForSelector('text=No issues')
    // Search does not find it outside the Archive.
    await page.locator('.sidebar .side-item', { hasText: 'All items' }).click()
    await page.fill('input[type=search], .search input', 'router')
    await page.waitForFunction(() => document.querySelectorAll('.row-item').length === 0)
    await page.fill('input[type=search], .search input', '')

    await page.locator('.sidebar .side-item', { hasText: 'Archive' }).click()
    assert.deepEqual(await page.locator('.row-item .row-name').allTextContents(), ['Old router'])

    // It is still archived after a reload: the flag is inside the sealed item.
    await page.reload(); await s.unlock(page, 'arc@example.test')
    await page.locator('.sidebar .side-item', { hasText: 'Archive' }).click()
    await page.locator('.row-item', { hasText: 'Old router' }).click()
    await page.getByRole('button', { name: 'Restore from archive' }).click()
    await page.waitForSelector('text=Restored from the archive')
    await page.waitForSelector('text=Nothing archived')
    await page.locator('.sidebar .side-item', { hasText: 'All items' }).click()
    assert.deepEqual((await page.locator('.row-item .row-name').allTextContents()).sort(), ['Bank', 'Old router'])
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})
