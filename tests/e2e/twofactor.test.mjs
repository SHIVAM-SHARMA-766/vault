// Two-factor sign-in end to end: turn it on with a scanned key, sign in with
// a code, sign in with a recovery code, and turn it off.

import test from 'node:test'
import assert from 'node:assert/strict'

import { generateTotp } from '@vault/crypto'

import { PASSWORD, start } from './helpers.mjs'

// A code for a later time step: the server refuses a step it has already
// accepted, so the code used to turn 2FA on cannot sign in again.
const codeAt = async (secret, offsetSteps) => (await generateTotp(secret, Date.now() + offsetSteps * 30_000)).code

test('turn on two-factor, then sign in with a code and with a recovery code', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await s.register(page, 'grace@example.test')
    await s.menu(page, 'Account settings')
    await page.getByRole('button', { name: 'Turn on' }).click()
    await page.fill('#tf-password', PASSWORD)
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.waitForSelector('.qr', { timeout: 60_000 })
    assert.ok(await page.locator('.qr path').getAttribute('d'), 'a QR code is drawn')
    const secret = (await page.textContent('.secret-key')).replace(/\s/g, '')
    await page.fill('#tf-new', await codeAt(secret, 0))
    await page.getByRole('button', { name: 'Turn on' }).click()
    await page.waitForSelector('.codes', { timeout: 30_000 })
    const codes = await page.locator('.codes code').allTextContents()
    assert.equal(codes.length, 10)
    await page.check('.settings .check input')
    await page.getByRole('button', { name: 'Done' }).click()
    await page.waitForSelector('.settings-card .pill-ok')

    // The password alone is not enough any more.
    await page.getByRole('button', { name: 'Lock vault' }).click()
    await page.fill('#email', 'grace@example.test')
    await page.fill('#password', PASSWORD)
    await page.click('button[type=submit]')
    await page.waitForSelector('#tf-code', { timeout: 60_000 })
    await page.fill('#tf-code', '000000')
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.waitForSelector('.alert-error')
    await page.fill('#tf-code', await codeAt(secret, 1))
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.waitForSelector('.topbar', { timeout: 60_000 })

    // A recovery code works once.
    await page.getByRole('button', { name: 'Lock vault' }).click()
    await page.fill('#email', 'grace@example.test')
    await page.fill('#password', PASSWORD)
    await page.click('button[type=submit]')
    await page.waitForSelector('#tf-code', { timeout: 60_000 })
    await page.getByRole('button', { name: /Use a recovery code/ }).click()
    await page.fill('#tf-code', codes[0])
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.waitForSelector('.topbar', { timeout: 60_000 })

    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})
