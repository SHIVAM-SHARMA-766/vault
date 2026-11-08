// Settings sections, preferences that follow the account to another device,
// the theme switch, auto-lock, and the operator's support contact.

import test from 'node:test'
import assert from 'node:assert/strict'

import { start } from './helpers.mjs'

test('settings sections have their own addresses, and a deep link survives unlocking', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await s.register(page, 'mira@example.test')
    await s.settings(page, 'Security')
    assert.ok(page.url().endsWith('/app/settings/security'))
    await page.waitForSelector('#s-sessions')
    assert.equal(await page.locator('#cp-current').count(), 0, 'the master password form is on Account, not here')
    await s.settings(page, 'Account')
    assert.ok(page.url().endsWith('/app/settings'))
    await page.waitForSelector('#cp-current')

    await page.goto(`${s.base}/app/settings/preferences`)
    await s.unlock(page, 'mira@example.test')
    await page.waitForSelector('.settings-head h1:has-text("Preferences")')
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})

test('on a phone, sections are chips', async () => {
  const s = await start()
  try {
    const phone = await s.person({ width: 400, height: 860 })
    await s.register(phone, 'pia@example.test')
    await s.settings(phone, 'Emergency access')
    await phone.waitForSelector('#em-email')
    assert.ok(phone.url().endsWith('/app/settings/emergency'))
  } finally {
    await s.stop()
  }
})

test('the theme switches at once, survives a reload before unlock, and follows the account to another device', async () => {
  const s = await start()
  try {
    const page = await s.person({ scheme: 'light' })
    await s.register(page, 'theo@example.test')
    await s.settings(page, 'Preferences')
    const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    const light = await bg()
    await page.getByRole('radio', { name: 'Dark' }).click()
    await page.waitForSelector('text=Preferences saved')
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark')
    assert.notEqual(await bg(), light)

    // The sign-in screen after a reload is already dark.
    await page.reload()
    await page.waitForSelector('#email')
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark')

    // A fresh browser (no local storage) picks it up from the server on unlock.
    const other = await s.person({ scheme: 'light' })
    await other.goto(`${s.base}/app/`)
    assert.equal(await other.evaluate(() => document.documentElement.dataset.theme ?? null), null)
    await s.unlock(other, 'theo@example.test')
    await other.waitForFunction(() => document.documentElement.dataset.theme === 'dark')

    // "Match system" clears it.
    await s.settings(other, 'Preferences')
    await other.getByRole('radio', { name: 'Match system' }).click()
    await other.waitForFunction(() => document.documentElement.dataset.theme === undefined)
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})

test('auto-lock and clipboard choices are saved encrypted and applied', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await s.register(page, 'lars@example.test')
    await s.settings(page, 'Preferences')
    await page.selectOption('#p-lock-minutes', '60')
    await page.waitForSelector('text=Preferences saved')
    await page.selectOption('#p-clip-seconds', '0')
    await page.waitForFunction(() => document.querySelectorAll('.toast').length >= 1)
    await page.waitForFunction(() => !document.querySelector('#p-clip-seconds').disabled)
    await s.menu(page, 'Vault')
    await page.waitForSelector('.sidebar-foot:has-text("Locks after 1 hour idle")')

    // On another device, the same choices arrive.
    const other = await s.person()
    await other.goto(`${s.base}/app/`)
    await s.unlock(other, 'lars@example.test')
    await other.waitForSelector('.sidebar-foot:has-text("Locks after 1 hour idle")')
    await s.settings(other, 'Preferences')
    assert.equal(await other.inputValue('#p-lock-minutes'), '60')
    assert.equal(await other.inputValue('#p-clip-seconds'), '0')
  } finally {
    await s.stop()
  }
})

test('locking on a hidden tab, when chosen', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await s.register(page, 'hana@example.test')
    await s.settings(page, 'Preferences')
    await page.getByText('Also lock as soon as I switch').click()
    await page.waitForSelector('text=Preferences saved')
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await page.waitForSelector('#email')
  } finally {
    await s.stop()
  }
})

test('the support contact an admin sets shows on the sign-in screen and the help page', async () => {
  const s = await start()
  try {
    const owner = await s.person()
    await s.register(owner, 'owner@example.test')
    await s.menu(owner, 'Admin panel')
    // The server card names the version; a development stack never calls the release feed.
    await owner.waitForSelector('.admin-card:has-text("Version dev")')
    await owner.waitForSelector('.admin-card:has-text("Updates"):has-text("Not checked")')
    await owner.fill('#pf-name', 'Rao Family Vault')
    await owner.fill('#pf-email', 'help@rao.example')
    await owner.locator('form[aria-labelledby=profile-title]').getByRole('button', { name: 'Save' }).click()
    await owner.waitForSelector('text=Name and support contact saved')
    await s.menu(owner, 'Help & support')
    await owner.waitForSelector('.support-contact a[href="mailto:help@rao.example"]')

    const visitor = await s.person()
    await visitor.goto(`${s.base}/app/`)
    await visitor.waitForSelector('.auth-support a[href="mailto:help@rao.example"]')
    assert.match(await visitor.textContent('.auth-foot'), /Rao Family Vault/)
    assert.equal(await visitor.title(), 'Rao Family Vault')
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})
