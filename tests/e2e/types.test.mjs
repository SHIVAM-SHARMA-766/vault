// More item types (D1): grouped in the picker, with their own fields, dates
// shown by locale and an expired badge, and listed in the sidebar only once
// the vault holds one.

import test from 'node:test'
import assert from 'node:assert/strict'

import { start } from './helpers.mjs'

test('a database and an expired passport: grouped picker, own fields, expiry badge, sidebar on demand', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await s.register(page, 'dev@example.test')
    const sidebar = page.locator('nav.sidebar')
    assert.equal(await sidebar.getByText('Databases').count(), 0, 'no empty type in the sidebar')

    await page.click('.topbar .btn-primary')
    const groups = await page.locator('#f-type optgroup').evaluateAll((els) => els.map((e) => e.getAttribute('label')))
    assert.deepEqual(groups, ['Everyday', 'Money', 'Documents', 'Technical'])
    await page.selectOption('#f-type', 'database')
    await page.fill('#f-name', 'Orders DB')
    await page.selectOption('#f-engine', 'postgresql')
    await page.fill('#f-host', 'db.internal')
    await page.fill('#f-port', '5432')
    await page.fill('#f-username', 'orders')
    await page.fill('#f-password', 'correct-horse-battery-staple-9')
    await page.click('.editor-foot .btn-primary')
    await page.waitForSelector('.detail >> text=PostgreSQL')
    assert.match(await page.textContent('.row-item:has-text("Orders DB")'), /db\.internal/, 'the host is the subtitle')
    await sidebar.getByText('Databases').waitFor()

    await page.click('.topbar .btn-primary')
    await page.selectOption('#f-type', 'passport')
    await page.fill('#f-name', 'Old passport')
    await page.fill('#f-fullName', 'Dev Kumar')
    await page.fill('#f-number', 'Z1234567')
    await page.fill('#f-expires', '2020-03-14')
    await page.click('.editor-foot .btn-primary')
    await page.waitForSelector('.detail .pill:has-text("Expired")')
    assert.match(await page.textContent('.detail'), /2020/)
    assert.match(await page.textContent('.detail'), /Mar/, 'the date is written out, not as 2020-03-14')

    await sidebar.getByText('Passports').click()
    assert.equal(await page.locator('.row-item').count(), 1)
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})
