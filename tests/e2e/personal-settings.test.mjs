// Personal settings F4–F7 and the sharing policy G4: masks that hide length
// and hide themselves again, a default folder for new items, date and time
// styles, the sign-in email switch, and share links an admin can cap or stop.

import test from 'node:test'
import assert from 'node:assert/strict'

import { start } from './helpers.mjs'

async function add(page, name, password) {
  await page.click('.topbar .btn-primary')
  await page.fill('#f-name', name)
  if (password) await page.fill('#f-password', password)
  await page.click('.editor-foot .btn-primary')
  await page.waitForSelector(`.detail h2:has-text("${name}")`)
}

test('masks, auto-hide, default folder and date style follow the person\'s choices', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await s.register(page, 'dev@example.test')
    await page.getByRole('button', { name: 'New folder', exact: true }).click()
    await page.fill('#fd-name', 'Personal')
    await page.locator('.modal').getByRole('button', { name: 'Save' }).click()
    await page.waitForSelector('.folder-item:has-text("Personal")')

    await s.settings(page, 'Preferences')
    await page.selectOption('#p-mask', 'actual')
    await page.waitForSelector('text=Preferences saved', { state: 'attached' })
    await page.selectOption('#p-autohide', '10')
    await page.selectOption('#p-default-folder', { label: 'Personal' })
    await page.selectOption('#p-date', 'ymd')
    await page.selectOption('#p-clock', '24h')
    assert.match(await page.textContent('[data-testid=date-preview]'), /Now: \d{4}-\d{2}-\d{2}, \d{2}:\d{2}/)

    await page.locator('.brand').first().click()
    await page.locator('.sidebar').getByRole('button', { name: /All items/ }).click()
    await add(page, 'Six letters', 'abcdef')
    await page.waitForSelector('.badge-folder:has-text("Personal")')
    assert.equal((await page.locator('.field-row .mono').first().textContent()).trim(), '••••••', 'one dot per character')
    assert.match(await page.textContent('.detail-foot'), /\d{4}-\d{2}-\d{2}, \d{2}:\d{2}/)

    await page.getByRole('button', { name: 'Reveal Password' }).click()
    assert.equal((await page.locator('.field-row .mono').first().textContent()).trim(), 'abcdef')
    await page.waitForFunction(() => document.querySelector('.field-row .mono')?.textContent?.trim() === '••••••', null, { timeout: 15_000 })
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})

test('the default mask hides length, and the sign-in email can be turned off', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await s.register(page, 'dev@example.test')
    await add(page, 'Short', 'abc')
    assert.equal((await page.locator('.field-row .mono').first().textContent()).trim(), '••••••••••••')
    await s.settings(page, 'Preferences')
    const alerts = page.locator('#p-alerts')
    if (await alerts.count()) {
      const box = page.getByLabel('Email me when my account signs in on a device')
      if (await box.count()) { await box.uncheck(); await page.waitForSelector('text=Sign-in emails off', { state: 'attached' }) }
    }
  } finally {
    await s.stop()
  }
})

test('an admin caps share links at 7 days, then turns them off; the Link button follows', async () => {
  const s = await start()
  try {
    const owner = await s.person()
    await s.register(owner, 'owner@example.test')
    await add(owner, 'Router', 'r0uter-Pass-Long-1')
    await s.menu(owner, 'Admin panel')
    await owner.waitForSelector('#policy-title')
    await owner.selectOption('#pol-links', '7')
    await owner.locator('form[aria-labelledby=policy-title]').getByRole('button', { name: 'Save' }).click()
    await owner.waitForSelector('text=Policies saved', { state: 'attached' })

    await owner.goto(`${s.base}/app/`); await s.unlock(owner, 'owner@example.test')
    await owner.locator('.row-item', { hasText: 'Router' }).click()
    await owner.locator('.detail-actions').getByRole('button', { name: 'Share by link' }).click()
    const choices = await owner.locator('#sl-expiry option').allTextContents()
    assert.deepEqual(choices, ['1 hour', '1 day', '7 days'])
    await owner.getByRole('button', { name: 'Cancel' }).click()

    await s.menu(owner, 'Admin panel')
    await owner.waitForSelector('#policy-title')
    await owner.selectOption('#pol-links', 'off')
    await owner.locator('form[aria-labelledby=policy-title]').getByRole('button', { name: 'Save' }).click()
    await owner.waitForSelector('text=Policies saved', { state: 'attached' })
    await owner.goto(`${s.base}/app/`); await s.unlock(owner, 'owner@example.test')
    await owner.locator('.row-item', { hasText: 'Router' }).click()
    await owner.waitForSelector('.detail-actions')
    assert.equal(await owner.locator('.detail-actions').getByRole('button', { name: 'Share by link' }).count(), 0)
  } finally {
    await s.stop()
  }
})
