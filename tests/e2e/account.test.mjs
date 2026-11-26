// Deleting your own account from Settings: it asks for everything it should,
// then the account is gone and the browser is locked.

import test from 'node:test'
import assert from 'node:assert/strict'

import { ACCOUNT_PASSWORD, PASSWORD, start } from './helpers.mjs'

test('delete my account: password and typed DELETE, then it is gone', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await s.register(page, 'leaving@example.test')
    await s.settings(page, 'Account')
    await page.getByRole('button', { name: 'Delete my account…' }).click()
    await page.waitForSelector('text=Export them first')
    const button = page.getByRole('button', { name: 'Delete my account permanently' })
    await page.fill('#del-pw', PASSWORD)
    assert.equal(await button.isDisabled(), true, 'not until DELETE is typed')
    await page.fill('#del-confirm', 'delete')
    assert.equal(await button.isDisabled(), true, 'exactly DELETE')
    await page.fill('#del-confirm', 'DELETE')

    await page.fill('#del-pw', 'not my password')
    await button.click()
    await page.waitForSelector('.danger-zone .alert-error:has-text("The master password is wrong")', { timeout: 60_000 })

    await page.fill('#del-pw', PASSWORD)
    await button.click()
    await page.waitForSelector('#account-password', { timeout: 60_000 })

    // The account no longer exists.
    await page.fill('#email', 'leaving@example.test')
    await page.fill('#account-password', ACCOUNT_PASSWORD)
    await page.click('button[type=submit]')
    await page.waitForSelector('.alert-error', { timeout: 60_000 })
  } finally {
    await s.stop()
  }
})
