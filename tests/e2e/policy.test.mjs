// Server policies (G1, G3, G7): an admin sets them in the panel; a new account
// is held to the password floor at sign-up, told what it still misses, and
// marked for the admin.

import test from 'node:test'
import assert from 'node:assert/strict'

import { ACCOUNT_PASSWORD, start } from './helpers.mjs'

test('an admin sets policies; sign-up enforces the password floor; gaps are shown and listed', async () => {
  const s = await start()
  try {
    const owner = await s.person()
    await s.register(owner, 'owner@example.test')
    await s.menu(owner, 'Admin panel')
    await owner.waitForSelector('#policy-title')
    await owner.getByLabel('Require two-factor sign-in').check()
    await owner.selectOption('#pol-score', '3')
    await owner.selectOption('#pol-idle', '5')
    await owner.selectOption('#pol-session', '7')
    await owner.selectOption('#pol-audit', '90')
    await owner.waitForSelector('text=Saving deletes log entries older than the new period')
    await owner.locator('form[aria-labelledby=policy-title]').getByRole('button', { name: 'Save' }).click()
    await owner.waitForSelector('text=Policies saved', { state: 'attached' })

    // A weak master password is refused before anything is sent.
    await s.setRegistration(true)
    const asha = await s.person()
    await asha.goto(`${s.base}/app/`)
    await asha.getByRole('button', { name: 'Create an account' }).click()
    await asha.fill('#r-email', 'asha@example.test')
    await asha.fill('#r-account', ACCOUNT_PASSWORD)
    await asha.fill('#r-account-confirm', ACCOUNT_PASSWORD)
    await asha.fill('#r-password', 'password1234')
    await asha.fill('#r-confirm', 'password1234')
    await asha.click('button[type=submit]')
    await asha.waitForSelector('text=rated at least Strong')

    // A strong one goes through; the vault says two-factor is still missing.
    await s.register(asha, 'asha@example.test')
    await asha.waitForSelector('[data-testid=server-policy-gap]')
    assert.match(await asha.textContent('[data-testid=server-policy-gap]'), /requires two-factor/)
    await asha.getByRole('link', { name: 'Open Security' }).click()
    await asha.waitForSelector('text=This server requires two-factor sign-in')

    // The auto-lock choice is capped by the policy.
    await s.settings(asha, 'Preferences')
    assert.match(await asha.textContent('main'), /5 min/)

    // The admin sees who misses it.
    await owner.locator('.sidebar .side-item', { hasText: 'Users' }).click()
    await owner.waitForSelector('text=Misses policy')
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})
