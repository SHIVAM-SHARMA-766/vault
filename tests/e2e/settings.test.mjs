// Phase 1 account settings, end to end: changing the master password, issuing
// a new recovery key, and getting back in with it when the password is lost.

import test from 'node:test'
import assert from 'node:assert/strict'

import { PASSWORD, start } from './helpers.mjs'

const NEW_PASSWORD = 'an entirely different long passphrase'

test('change the master password; the new one unlocks, the old one does not', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await s.register(page, 'carol@example.test')
    await s.menu(page, 'Account settings')
    await page.waitForSelector('#cp-current')
    assert.ok(page.url().endsWith('/app/settings'))
    await page.fill('#cp-current', PASSWORD)
    await page.fill('#cp-new', NEW_PASSWORD)
    await page.fill('#cp-confirm', NEW_PASSWORD)
    await page.getByRole('button', { name: 'Change master password' }).click()
    await page.waitForSelector('text=Master password changed', { timeout: 60_000 })

    await page.getByRole('button', { name: 'Lock vault' }).click()
    await page.fill('#password', PASSWORD)
    await page.click('button[type=submit]')
    await page.waitForSelector('.alert-error', { timeout: 60_000 })
    await s.unlock(page, 'carol@example.test', NEW_PASSWORD)
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})

test('a wrong current password is refused', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await s.register(page, 'dan@example.test')
    await page.goto(`${s.base}/app/settings`)
    // A reload locks the vault; the deep link survives the unlock.
    await s.unlock(page, 'dan@example.test')
    await page.waitForSelector('#cp-current')
    await page.fill('#cp-current', 'not my password at all')
    await page.fill('#cp-new', NEW_PASSWORD)
    await page.fill('#cp-confirm', NEW_PASSWORD)
    await page.getByRole('button', { name: 'Change master password' }).click()
    await page.waitForSelector('.alert-error', { timeout: 60_000 })
    assert.equal(await page.textContent('.settings-card .alert-error'), 'The current master password is wrong.')
  } finally {
    await s.stop()
  }
})

test('issue a new recovery key, then use it to get back in with a new password', async () => {
  const s = await start()
  try {
    const page = await s.person()
    const original = await s.register(page, 'erin@example.test')
    await s.menu(page, 'Account settings')
    await page.fill('#rk-current', PASSWORD)
    await page.getByRole('button', { name: 'Issue a new recovery key' }).click()
    await page.waitForSelector('.settings .recovery-key code', { timeout: 60_000 })
    const fresh = (await page.textContent('.settings .recovery-key code'))?.trim()
    assert.ok(fresh && fresh !== original)
    await page.check('.settings .check input')
    await page.getByRole('button', { name: 'Done' }).click()
    await page.getByRole('button', { name: 'Lock vault' }).click()

    // The old recovery key no longer works.
    await page.getByRole('button', { name: /Use your recovery key/ }).click()
    await page.fill('#rc-email', 'erin@example.test')
    await page.fill('#rc-key', original)
    await page.getByRole('button', { name: 'Open my vault' }).click()
    await page.waitForSelector('.alert-error', { timeout: 60_000 })

    // The new one does, and leads to a new master password.
    await page.fill('#rc-key', fresh)
    await page.getByRole('button', { name: 'Open my vault' }).click()
    await page.waitForSelector('#rc-new', { timeout: 60_000 })
    await page.fill('#rc-new', NEW_PASSWORD)
    await page.fill('#rc-confirm', NEW_PASSWORD)
    await page.getByRole('button', { name: /Set master password/ }).click()
    await page.waitForSelector('.topbar', { timeout: 60_000 })

    await page.getByRole('button', { name: 'Lock vault' }).click()
    await s.unlock(page, 'erin@example.test', NEW_PASSWORD)
  } finally {
    await s.stop()
  }
})

test('the identity fingerprint is shown in settings', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await s.register(page, 'frank@example.test')
    await s.menu(page, 'Account settings')
    await page.waitForSelector('.fingerprint code', { timeout: 30_000 })
    assert.match(await page.textContent('.fingerprint code'), /^[0-9a-f]{4}( [0-9a-f]{4}){7}$/)
  } finally {
    await s.stop()
  }
})
