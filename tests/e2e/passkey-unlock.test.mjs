// Unlock with a passkey (decisions/0034), with Chromium's virtual authenticator
// standing in for Touch ID: a discoverable credential that verifies its user
// and offers the PRF extension. Add it, lock, sign in with no email and no
// password, see the vault decrypted, then remove it.

import test from 'node:test'
import assert from 'node:assert/strict'

import { PASSWORD, start } from './helpers.mjs'

async function platformPasskey(page, { prf = true } = {}) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: prf, automaticPresenceSimulation: true },
  })
}

test('add a passkey, sign in with it alone, then remove it', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await platformPasskey(page)
    await s.register(page, 'touch@example.test')
    await page.click('.topbar .btn-primary')
    await page.fill('#f-name', 'Bank')
    await page.fill('#f-password', 'a-long-strong-and-unique-password-1')
    await page.click('.editor-foot .btn-primary')
    await page.waitForSelector('.detail h2:has-text("Bank")')

    await s.settings(page, 'Security')
    const card = page.locator('section[aria-labelledby=s-passkeys]')
    await card.getByRole('button', { name: 'Add a passkey to unlock' }).click()
    await page.fill('#pk-pw', PASSWORD)
    await page.fill('#pk-name', 'MacBook')
    await card.getByRole('button', { name: 'Add passkey' }).click()
    await card.locator('.device-row:has-text("MacBook")').waitFor()
    await card.locator('.pill:has-text("1 added")').waitFor()

    // Lock, then sign in with the passkey: no email, no password.
    await page.getByRole('button', { name: 'Lock vault' }).click()
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click()
    await page.waitForSelector('.topbar')
    await page.click('.topbar .brand')
    await page.locator('.row-item', { hasText: 'Bank' }).click()
    await page.waitForSelector('.detail h2:has-text("Bank")')

    // The account behind it is the right one, and it was used.
    await s.settings(page, 'Account')
    await page.waitForSelector('text=touch@example.test')
    await s.settings(page, 'Security')
    await card.locator('.device-row:has-text("last used")').waitFor()

    await card.getByRole('button', { name: 'Stop MacBook unlocking' }).click()
    await card.getByRole('button', { name: 'Remove', exact: true }).click()
    await card.locator('.pill:has-text("Off")').waitFor()

    // The passkey still exists on the device, but no longer opens anything.
    await page.getByRole('button', { name: 'Lock vault' }).click()
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click()
    await page.waitForSelector('text=That passkey does not unlock a vault on this server.')
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})

test('a passkey without PRF is not saved, and says why', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await platformPasskey(page, { prf: false })
    await s.register(page, 'noprf@example.test')
    await s.settings(page, 'Security')
    const card = page.locator('section[aria-labelledby=s-passkeys]')
    await card.getByRole('button', { name: 'Add a passkey to unlock' }).click()
    await page.fill('#pk-pw', PASSWORD)
    await card.getByRole('button', { name: 'Add passkey' }).click()
    await card.locator('text=does not offer the PRF extension').waitFor()
    assert.equal(await card.locator('.device-row').count(), 0)
  } finally {
    await s.stop()
  }
})
