// The generator: passwords and passphrases, and defaults from Preferences.

import test from 'node:test'
import assert from 'node:assert/strict'

import { start } from './helpers.mjs'

test('a passphrase from the EFF list goes into the password field', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await s.register(page, 'gen@example.test')
    await page.click('.topbar .btn-primary')
    await page.getByRole('button', { name: 'Generate' }).click()
    await page.getByRole('radio', { name: 'Passphrase' }).click()
    await page.waitForFunction(() => /^[a-z-]+(-[a-z-]+){5}$/.test(document.querySelector('.generator-out code')?.textContent ?? ''))
    const phrase = await page.textContent('.generator-out code')
    assert.match(await page.textContent('.generator'), /about 78 bits/)
    await page.getByRole('button', { name: 'Use this passphrase' }).click()
    assert.equal(await page.inputValue('#f-password'), phrase)
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})

test('Preferences make the passphrase the default, with its own shape', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await s.register(page, 'pref@example.test')
    await s.settings(page, 'Preferences')
    await page.locator('section[aria-labelledby="p-gen"]').getByRole('radio', { name: 'Passphrase' }).click()
    await page.waitForSelector('#p-words')
    await page.selectOption('#p-words', '4')
    await page.waitForFunction(() => !document.querySelector('#p-sep').disabled)
    await page.selectOption('#p-sep', '.')
    await page.waitForFunction(() => !document.querySelector('#p-sep').disabled)
    await s.menu(page, 'Vault')
    await page.click('.topbar .btn-primary')
    await page.getByRole('button', { name: 'Generate' }).click()
    await page.waitForFunction(() => /^[a-z-]+(\.[a-z-]+){3}$/.test(document.querySelector('.generator-out code')?.textContent ?? ''))
  } finally {
    await s.stop()
  }
})

test('a used password lands in the generator history, survives a fresh unlock, and can be cleared', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await s.register(page, 'hist@example.test')
    await page.click('.topbar .btn-primary')
    await page.getByRole('button', { name: 'Generate' }).click()
    await page.waitForFunction(() => (document.querySelector('.generator-out code')?.textContent ?? '').length >= 20)
    const used = await page.textContent('.generator-out code')
    await page.getByRole('button', { name: 'Use this password' }).click()
    assert.equal(await page.inputValue('#f-password'), used)

    // Back in the generator: the history holds it, masked until shown.
    await page.getByRole('button', { name: 'Generate' }).click()
    await page.getByRole('button', { name: 'History (1)' }).click()
    const row = page.locator('.generator .gen-history li').first()
    assert.ok(!(await row.locator('code').textContent()).includes(used), 'masked')
    await row.getByRole('button', { name: 'Show' }).click()
    assert.equal(await row.locator('code').textContent(), used)

    // Sealed with the preferences: a new unlock reads it back.
    await page.goto(`${s.base}/app/settings/preferences`)
    await s.unlock(page, 'hist@example.test')
    const block = page.locator('.gen-history-block')
    await block.locator('.gen-history li').first().waitFor()
    await block.getByRole('button', { name: 'Show' }).click()
    assert.equal(await block.locator('.gen-history code').textContent(), used)
    await block.getByRole('button', { name: 'Clear history' }).click()
    await block.locator('text=Nothing yet.').waitFor()
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})
