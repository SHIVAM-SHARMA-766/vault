// Passkeys and security keys as a second factor (D9), with Chromium's virtual
// authenticator standing in for a YubiKey: add one, sign in with it, keep the
// recovery codes, remove it.

import test from 'node:test'
import assert from 'node:assert/strict'

import { ACCOUNT_PASSWORD, PASSWORD, start } from './helpers.mjs'

async function virtualKey(page) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'usb', hasResidentKey: false, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  })
  return { cdp, authenticatorId }
}

test('add a security key, sign in with it, then remove it', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await virtualKey(page)
    await s.register(page, 'keys@example.test')
    await s.settings(page, 'Security')
    await page.getByRole('button', { name: 'Add a passkey or security key' }).click()
    await page.fill('#key-pw', PASSWORD)
    await page.fill('#key-name', 'YubiKey 5')
    await page.locator('form:has(#key-name)').getByRole('button', { name: 'Continue' }).click()
    await page.waitForSelector('text=Save these recovery codes')
    assert.equal(await page.locator('#s-keys ~ * .codes li, section[aria-labelledby=s-keys] .codes li').count(), 10)
    await page.getByRole('button', { name: 'I have saved them' }).click()
    await page.waitForSelector('section[aria-labelledby=s-keys] .device-row:has-text("YubiKey 5")')

    // Sign in again: the key is asked for, and answers.
    await s.menu(page, 'Sign out of this device')
    await page.fill('#email', 'keys@example.test')
    await page.fill('#account-password', ACCOUNT_PASSWORD)
    await page.click('button[type=submit]')
    await page.waitForSelector('text=Use your passkey or security key')
    await page.getByRole('button', { name: 'Use my key' }).click()
    await page.waitForSelector('.account-line', { timeout: 60_000 })
    await page.fill('#password', PASSWORD)
    await page.click('button[type=submit]')
    await page.waitForSelector('.topbar', { timeout: 60_000 })

    // Remove it with the password and the key itself.
    await s.settings(page, 'Security')
    await page.getByRole('button', { name: 'Remove YubiKey 5' }).click()
    await page.fill('#rk-pw', PASSWORD)
    await page.locator('section[aria-labelledby=s-keys]').getByRole('button', { name: 'Remove', exact: true }).click()
    await page.waitForSelector('text=Key removed', { state: 'attached' })
    await page.waitForSelector('section[aria-labelledby=s-keys] .pill:has-text("None")')
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})
