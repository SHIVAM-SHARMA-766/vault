// Phase 2: first-run setup. A brand-new server prints a one-time link; the
// person who opens it creates the owner account and reaches the admin panel.

import test from 'node:test'
import assert from 'node:assert/strict'

import { PASSWORD, start } from './helpers.mjs'

test('the setup link creates the owner on a server with no accounts', async () => {
  const s = await start({ owner: '' })
  try {
    const code = s.log().match(/setup code: (\S+)/)?.[1]
    assert.ok(code, 'a setup code is printed')

    const page = await s.person()
    await page.goto(`${s.base}/app/?setup=${encodeURIComponent(code)}`)
    await page.waitForSelector('h2:has-text("Create the owner account")')
    assert.equal(await page.locator('#r-invite').count(), 0, 'the code is not asked for again')
    await page.fill('#r-email', 'founder@example.test')
    await page.fill('#r-password', PASSWORD)
    await page.fill('#r-confirm', PASSWORD)
    await page.click('button[type=submit]')
    await page.waitForSelector('.recovery-key', { timeout: 60_000 })
    await page.check('.check input')
    await page.getByRole('button', { name: 'Continue to sign in' }).click()
    assert.equal(new URL(page.url()).search, '', 'the code leaves the address bar')
    await s.unlock(page, 'founder@example.test')

    await s.menu(page, 'Admin panel')
    await page.waitForSelector('.admin-section')
    await page.getByRole('button', { name: 'Account menu' }).click()
    assert.match(await page.textContent('.menu-head'), /Owner/)

    // The link is spent: a second visitor is refused.
    const other = await s.person()
    await other.goto(`${s.base}/app/?setup=${encodeURIComponent(code)}`)
    await other.fill('#r-email', 'late@example.test')
    await other.fill('#r-password', PASSWORD)
    await other.fill('#r-confirm', PASSWORD)
    await other.click('button[type=submit]')
    await other.waitForSelector('.alert-error', { timeout: 60_000 })
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})
