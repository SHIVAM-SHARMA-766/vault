// Languages (E9): Hindi chosen in Preferences changes the app at once, is
// kept for the sign-in page after locking, and a Spanish browser starts in
// Spanish. Untranslated text stays in English.

import test from 'node:test'
import assert from 'node:assert/strict'

import { start } from './helpers.mjs'

test('Hindi from Preferences applies at once and stays for the sign-in page', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await s.register(page, 'dev@example.test')
    await s.settings(page, 'Preferences')
    await page.selectOption('#p-lang', 'hi')
    await page.waitForSelector('h2:has-text("भाषा")')
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'hi')
    await page.locator('.brand').first().click()
    await page.waitForSelector('.sidebar >> text=सभी आइटम')
    await page.waitForSelector('text=नया आइटम')
    await page.getByRole('button', { name: 'वॉल्ट लॉक करें' }).click()
    await page.waitForSelector('text=अपना वॉल्ट खोलें')

    // Unlocking again keeps Hindi; switching back to English applies at once.
    await s.unlock(page, 'dev@example.test')
    await page.waitForSelector('.sidebar >> text=सभी आइटम')
    await page.goto(`${s.base}/app/settings/preferences`)
    await s.unlock(page, 'dev@example.test')
    // Wait for the saved preferences to arrive before changing one.
    await page.waitForFunction(() => (document.querySelector('#p-lang'))?.value === 'hi'.toString())
    await page.selectOption('#p-lang', 'en')
    await page.waitForSelector('h2:has-text("Language")')
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en')
  } finally {
    await s.stop()
  }
})

test('a Spanish browser starts in Spanish', async () => {
  const s = await start()
  try {
    const page = await s.person({ locale: 'es-ES' })
    await page.goto(`${s.base}/app/`)
    await page.waitForSelector('text=Abre tu bóveda')
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'es')
  } finally {
    await s.stop()
  }
})
