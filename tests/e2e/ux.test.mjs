// The screen-by-screen UX pass (backlog E0/E3): each fix found by looking at
// the real screens, kept fixed.

import test from 'node:test'
import assert from 'node:assert/strict'

import { start } from './helpers.mjs'

test('on a phone, the empty vault message is on screen and nothing scrolls sideways', async () => {
  const s = await start()
  try {
    const phone = await s.person({ width: 390, height: 844 })
    await s.register(phone, 'pho@example.test')
    const box = await phone.locator('.empty h3').boundingBox()
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390, `the heading sits at ${JSON.stringify(box)}`)
    assert.deepEqual(await phone.evaluate(() => [document.documentElement.scrollWidth, innerWidth]), [390, 390])
  } finally {
    await s.stop()
  }
})

test('a new vault shows a getting-started checklist that ticks itself off, and can be hidden', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await s.register(page, 'gina@example.test')
    await page.waitForSelector('.getting-started')
    assert.match(await page.textContent('.getting-started'), /4 of 4 steps left/)

    await page.locator('.getting-started').getByRole('button', { name: 'Add an item' }).click()
    await page.fill('#f-name', 'Bank')
    await page.fill('#f-password', 'a-strong-unique-password-123!')
    await page.click('.editor-foot .btn-primary')
    await page.waitForSelector('.detail h2:has-text("Bank")')
    await page.getByRole('button', { name: 'Back' }).click().catch(() => {})
    await page.locator('.sidebar .side-item', { hasText: 'All items' }).click()
    await page.evaluate(() => document.querySelector('.row-active')?.blur())

    // Deselect by reloading the vault view: the checklist reflects the item.
    await page.reload(); await s.unlock(page, 'gina@example.test')
    await page.waitForSelector('.getting-started')
    assert.match(await page.textContent('.getting-started'), /3 of 4 steps left/)
    await page.getByRole('button', { name: 'I have stored it' }).click()
    assert.match(await page.textContent('.getting-started'), /2 of 4 steps left/)

    await page.getByRole('link', { name: 'Choose a schedule' }).click()
    await page.waitForSelector('#b-freq')
    await page.selectOption('#b-freq', 'daily')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.waitForSelector('text=Backup settings saved')
    await s.menu(page, 'Vault')
    await page.waitForSelector('.getting-started:has-text("1 of 4 steps left")')

    await page.getByRole('button', { name: 'Hide this' }).click()
    await page.waitForSelector('.pane-empty')
    await page.reload(); await s.unlock(page, 'gina@example.test')
    await page.waitForSelector('.pane-empty')
    assert.equal(await page.locator('.getting-started').count(), 0)
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})

test('sign-in offers only the ways in this server has', async () => {
  const s = await start()
  try {
    // Open registration (the dev stack's default): create, no request form, code behind a link.
    const page = await s.person()
    await page.goto(`${s.base}/app/`)
    await page.getByRole('button', { name: 'Other ways to sign in' }).click()
    await page.waitForSelector('.auth-options')
    assert.equal(await page.getByRole('button', { name: /Request access/ }).count(), 0)
    await page.getByRole('button', { name: 'Back to sign in' }).click()
    await page.getByRole('button', { name: 'Create an account' }).click()
    await page.waitForSelector('button:has-text("I have an invitation code")')
    assert.equal(await page.locator('#r-invite').count(), 0)

    // Closed, with nobody yet: the owner's setup code is still offered.
    await s.setRegistration(false)
    await page.goto(`${s.base}/app/`)
    await page.waitForSelector('.auth-switch button')
    assert.deepEqual(await page.locator('.auth-switch button').allTextContents(), ['Create the owner account'])

    // Closed, once someone exists: only a request for access.
    await s.setRegistration(true)
    const first = await s.person()
    await s.register(first, 'first@example.test')
    await s.setRegistration(false)
    await page.goto(`${s.base}/app/`)
    await page.waitForSelector('#account-password')
    assert.equal(await page.getByRole('button', { name: 'Create an account' }).count(), 0)
    await page.getByRole('button', { name: 'Other ways to sign in' }).click()
    await page.getByRole('button', { name: /Request access/ }).waitFor()
  } finally {
    await s.stop()
  }
})

test('organizations: a newcomer sees how to start one before the fingerprint', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await s.register(page, 'otto@example.test')
    await s.menu(page, 'Organizations')
    await page.waitForSelector('#o-new')
    const order = await page.evaluate(() => [...document.querySelectorAll('main h2')].map((h) => h.id))
    assert.ok(order.indexOf('o-new') < order.indexOf('o-fp'), order.join(','))
  } finally {
    await s.stop()
  }
})

test('offline: saving says what happened and what to do, in plain words', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await s.register(page, 'nia@example.test')
    await page.click('.topbar .btn-primary')
    await page.fill('#f-name', 'Offline item')
    await page.fill('#f-password', 'whatever-it-is-123')
    await page.context().setOffline(true)
    await page.click('.editor-foot .btn-primary')
    await page.waitForSelector('text=Check your internet connection')
    await page.context().setOffline(false)
  } finally {
    await s.stop()
  }
})

test('radio buttons keep their size (the global input style once stretched them)', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await s.register(page, 'rad@example.test')
    await s.settings(page, 'Backups')
    const box = await page.locator('.radio input').first().boundingBox()
    assert.ok(box && box.width <= 20 && box.height <= 20, JSON.stringify(box))
  } finally {
    await s.stop()
  }
})
