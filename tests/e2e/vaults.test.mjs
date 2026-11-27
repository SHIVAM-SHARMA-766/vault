// Several vaults: a new vault becomes the view, new items go into it, each
// vault shows only its own, items move between vaults with their history,
// everything opens again after a fresh unlock, and deleting a vault moves its
// items to Personal.

import test from 'node:test'
import assert from 'node:assert/strict'

import { start } from './helpers.mjs'

async function addLogin(page, name, password) {
  await page.click('.topbar .btn-primary')
  await page.fill('#f-name', name)
  await page.fill('#f-password', password)
  await page.click('.editor-foot .btn-primary')
  await page.waitForSelector(`.detail h2:has-text("${name}")`)
}
const names = (page) => page.locator('.row-item .row-name').allTextContents()
const side = (page, label) => page.locator('.vault-switch .side-item', { hasText: label }).first()

test('vaults keep their own items, move them with history, survive an unlock, and empty into Personal on delete', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await s.register(page, 'vaults@example.test')
    await addLogin(page, 'Home Wi-Fi', 'violet-Tractor-Mango-41')

    await page.getByRole('button', { name: 'New vault' }).click()
    await page.fill('#fd-name', 'Work')
    await page.click('.modal .btn-primary')
    await page.waitForSelector('text=Vault “Work” created')
    assert.equal(await side(page, 'Work').getAttribute('aria-current'), 'true', 'the new vault is the view')
    assert.deepEqual(await names(page), [], 'a new vault is empty')

    await page.click('.topbar .btn-primary')
    assert.equal(await page.locator('#f-vault option:checked').textContent(), 'Work', 'new items go into the vault in view')
    await page.click('.editor .btn-secondary:has-text("Cancel"), [aria-label="Close"]')
    await addLogin(page, 'Jira', 'first-Work-Password-77')
    assert.match(await page.textContent('.detail .badge-vault'), /Work/)
    // A second version, so the move must carry history.
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.fill('#f-password', 'second-Work-Password-88')
    await page.click('.editor-foot .btn-primary')
    await page.waitForSelector('.detail h2:has-text("Jira")')

    await side(page, 'Personal').click()
    assert.deepEqual(await names(page), ['Home Wi-Fi'])
    await side(page, 'All vaults').click()
    assert.deepEqual(await names(page), ['Home Wi-Fi', 'Jira'])

    // A fresh unlock opens both vaults.
    await page.goto(`${s.base}/app/`)
    await s.unlock(page, 'vaults@example.test')
    await side(page, 'Work').click()
    await page.locator('.row-item', { hasText: 'Jira' }).click()

    // Move to Personal: re-sealed, history and all.
    await page.locator('.detail .badge-vault select').selectOption({ label: 'Personal' })
    await page.waitForSelector('text=Moved to Personal')
    await side(page, 'Personal').click()
    assert.deepEqual(await names(page), ['Home Wi-Fi', 'Jira'])
    await page.locator('.row-item', { hasText: 'Jira' }).click()
    // The earlier version was re-sealed too: it still opens under the new key.
    await page.getByRole('button', { name: 'History' }).click()
    await page.locator('.history .history-item').first().waitFor()
    assert.equal(await page.locator('.history .history-item').count(), 1)
    await page.getByRole('button', { name: 'History' }).click()

    // Back to Work, then delete Work: its item returns to Personal.
    await page.locator('.detail .badge-vault select').selectOption({ label: 'Work' })
    await page.waitForSelector('text=Moved to Work')
    await page.locator('.vault-row', { hasText: 'Work' }).hover()
    await page.getByRole('button', { name: 'Rename vault Work' }).click()
    await page.fill('#fd-name', 'Office')
    await page.click('.modal .btn-primary')
    await side(page, 'Office').waitFor()
    await page.locator('.vault-row', { hasText: 'Office' }).hover()
    await page.getByRole('button', { name: 'Delete vault Office' }).click()
    await page.click('.modal .btn-danger')
    await page.waitForSelector('text=Vault deleted')
    assert.equal(await page.locator('.vault-switch .side-item', { hasText: 'Office' }).count(), 0)
    assert.deepEqual(await names(page), ['Home Wi-Fi', 'Jira'], 'nothing lost')
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})
