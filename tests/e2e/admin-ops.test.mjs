// Admin operations in the panel: the System tab (backups, email templates,
// rate limits) and the sign-in allow-list on the Policies card.

import test from 'node:test'
import assert from 'node:assert/strict'

import { start } from './helpers.mjs'

test('System tab: backup status, an email template previewed and saved, the rate limits', async () => {
  const s = await start()
  try {
    const owner = await s.person()
    await s.register(owner, 'owner@example.test')
    await s.menu(owner, 'Admin panel')
    await owner.locator('.sidebar .side-item', { hasText: 'System' }).click()
    await owner.waitForSelector('#sys-backup')
    assert.match(await owner.textContent('.admin-main'), /Backups are off|Every/)

    await owner.getByRole('tab', { name: 'Emails' }).click()
    await owner.selectOption('#tpl-kind', 'invite')
    await owner.fill('#tpl-subject', 'Welcome to {server}')
    await owner.fill('#tpl-message', 'Hello from the IT desk.')
    await owner.getByRole('button', { name: 'Preview' }).click()
    await owner.waitForSelector('.tpl-preview')
    assert.match(await owner.textContent('.tpl-preview'), /Subject: Welcome to Vault/)
    assert.match(await owner.textContent('.tpl-preview'), /Hello from the IT desk\.[\s\S]*invite=/)
    await owner.locator('form[aria-labelledby=sys-templates]').getByRole('button', { name: 'Save' }).click()
    await owner.waitForSelector('text=Email template saved', { state: 'attached' })
    await owner.waitForSelector('#tpl-kind option:has-text("Invitation (changed)")', { state: 'attached' })
    await owner.getByRole('button', { name: 'Use the standard email' }).click()
    await owner.waitForSelector('text=Back to the standard email', { state: 'attached' })

    await owner.getByRole('tab', { name: 'Sign-in limits' }).click()
    await owner.waitForSelector('.limits td:has-text("Sign-in attempts")')
    assert.match(await owner.textContent('.limits'), /10 per 15 minutes/)
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})

test('an allow-list keeps a user outside it from signing in, and says why', async () => {
  const s = await start()
  try {
    const owner = await s.person()   // 10.0.0.1
    await s.register(owner, 'owner@example.test')
    await s.setRegistration(true)
    const user = await s.person()    // 10.0.0.2
    await s.register(user, 'user@example.test')
    await user.getByRole('button', { name: 'Lock' }).click()

    await s.menu(owner, 'Admin panel')
    await owner.waitForSelector('#policy-title')
    // Leaving out the owner's own address is refused with that address.
    await owner.fill('#pol-networks', '192.0.2.0/24')
    await owner.locator('form[aria-labelledby=policy-title]').getByRole('button', { name: 'Save' }).click()
    await owner.waitForSelector('text=is not in the sign-in list', { state: 'attached' })
    // A new line, then the owner's own address.
    await owner.locator('#pol-networks').press('End')
    await owner.locator('#pol-networks').press('Enter')
    await owner.locator('#pol-networks').type('10.0.0.1/32')
    assert.equal(await owner.inputValue('#pol-networks'), '192.0.2.0/24\n10.0.0.1/32')
    await owner.locator('form[aria-labelledby=policy-title]').getByRole('button', { name: 'Save' }).click()
    await owner.waitForSelector('text=Policies saved', { state: 'attached' })

    await s.unlock(user, 'user@example.test').catch(() => {})
    await user.waitForSelector('text=Signing in from this network is not allowed')
    assert.equal(await user.locator('text=has been disabled').count(), 0, 'not mistaken for a disabled account')
  } finally {
    await s.stop()
  }
})
