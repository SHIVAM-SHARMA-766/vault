// Signing in in two steps (decisions/0036), in the browser: the account sign-in
// is kept, so a lock asks only for the master password; signing out of the
// device asks for the account again; the account password changes, is reset
// by an emailed link, or is cleared by an administrator.

import test from 'node:test'
import assert from 'node:assert/strict'

import { ACCOUNT_PASSWORD, PASSWORD, start } from './helpers.mjs'

const NEW_ACCOUNT = 'a brand new account passphrase'

test('lock asks only the master password; sign out asks the account; change and email reset work', async () => {
  const s = await start({ env: { DEV_MAIL: '1' } })
  try {
    const page = await s.person()
    await s.register(page, 'dana@example.test')

    // Lock: still signed in to the account, so only the master password.
    await page.getByRole('button', { name: 'Lock vault' }).click()
    await page.waitForSelector('.account-line')
    assert.match(await page.textContent('.account-line'), /dana@example\.test/)
    assert.equal(await page.locator('#account-password').count(), 0)
    await page.fill('#password', 'not my master password')
    await page.click('button[type=submit]')
    await page.waitForSelector('text=That master password is not right.')
    await page.fill('#password', PASSWORD)
    await page.click('button[type=submit]')
    await page.waitForSelector('.topbar', { timeout: 60_000 })

    // Change the account password in Settings.
    await s.settings(page, 'Security')
    const card = page.locator('section[aria-labelledby=s-account-pw]')
    await card.getByRole('button', { name: 'Change account password' }).click()
    await page.fill('#ap-current', ACCOUNT_PASSWORD)
    await page.fill('#ap-new', NEW_ACCOUNT)
    await page.fill('#ap-confirm', NEW_ACCOUNT)
    await card.getByRole('button', { name: 'Change it' }).click()
    await page.waitForSelector('text=Account password changed', { state: 'attached', timeout: 60_000 })

    // Sign out of the device: the account step again; the old one fails, the new one works.
    await s.menu(page, 'Sign out of this device')
    await page.fill('#email', 'dana@example.test')
    await page.fill('#account-password', ACCOUNT_PASSWORD)
    await page.click('button[type=submit]')
    await page.waitForSelector('text=Wrong email or account password')
    await s.unlock(page, 'dana@example.test', PASSWORD, { accountPassword: NEW_ACCOUNT })

    // Forgotten: an emailed link sets another, and every device signs in again.
    await s.menu(page, 'Sign out of this device')
    await page.getByRole('button', { name: 'Forgot your account password?' }).click()
    await page.fill('#forgot-email', 'dana@example.test')
    await page.getByRole('button', { name: 'Send the link' }).click()
    await page.waitForSelector('text=a link to reset its account password is on its way')
    const mail = (await (await fetch(`${s.base}/__dev/outbox`)).json()).find((m) => /Reset your Vault account password/.test(m.subject))
    assert.ok(mail, 'the reset email was sent')
    const link = /https?:\/\/\S+account-reset=\S+/.exec(mail.text)[0]
    await page.goto(link)
    await page.waitForSelector('#reset-account')
    assert.equal(new URL(page.url()).hash, '', 'the code leaves the address bar')
    await page.fill('#reset-account', ACCOUNT_PASSWORD)
    await page.fill('#reset-account-confirm', ACCOUNT_PASSWORD)
    await page.getByRole('button', { name: 'Set it' }).click()
    await page.waitForSelector('text=Account password changed')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await s.unlock(page, 'dana@example.test')
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})

test('an administrator clears an account password; the person signs in once with the master password and picks a new one', async () => {
  const s = await start()
  try {
    const owner = await s.person()
    await s.register(owner, 'owner@example.test')
    await s.setRegistration(true)
    const eve = await s.person()
    await s.register(eve, 'eve@example.test')
    await s.menu(eve, 'Sign out of this device')

    await owner.goto(`${s.base}/app/console/server/users`)
    await s.unlock(owner, 'owner@example.test')
    owner.once('dialog', (d) => d.accept())
    // The only account other than the owner's own (the list names no addresses).
    await owner.getByRole('button', { name: 'Reset account password' }).first().click()
    await owner.waitForSelector('text=Account password cleared', { state: 'attached' })

    await eve.getByRole('button', { name: /First sign-in since accounts were added/ }).click()
    await eve.fill('#email', 'eve@example.test')
    await eve.fill('#password', PASSWORD)
    await eve.click('button[type=submit]')
    await eve.waitForSelector('#new-account', { timeout: 60_000 })
    await eve.fill('#new-account', PASSWORD)
    await eve.fill('#new-account-confirm', PASSWORD)
    await eve.getByRole('button', { name: 'Save and open my vault' }).click()
    await eve.waitForSelector('text=Choose something different from your master password')
    await eve.fill('#new-account', NEW_ACCOUNT)
    await eve.fill('#new-account-confirm', NEW_ACCOUNT)
    await eve.getByRole('button', { name: 'Save and open my vault' }).click()
    await eve.waitForSelector('.topbar', { timeout: 60_000 })
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})
