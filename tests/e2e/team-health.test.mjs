// Team password health (decisions/0032, 2c): weak and reused passwords across
// the collections an admin manages, found in the admin's browser.

import test from 'node:test'
import assert from 'node:assert/strict'

import { start } from './helpers.mjs'

async function shareItem(s, page, name, password) {
  await s.menu(page, 'Vault')
  await page.click('.topbar .btn-primary')
  await page.fill('#f-name', name)
  await page.fill('#f-password', password)
  await page.click('.editor-foot .btn-primary')
  await page.waitForSelector(`.detail h2:has-text("${name}")`)
  await page.locator('.detail-actions').getByRole('button', { name: 'Share', exact: true }).click()
  await page.selectOption('select[aria-label="Collection"]', { label: 'Acme / Ops' })
  await page.getByRole('button', { name: 'Move to collection' }).click()
  await page.waitForSelector('.badge-shared:has-text("Acme / Ops")')
}

test('team password health finds weak and reused passwords in the collections an admin manages', async () => {
  const s = await start({ owner: 'alice@example.test' })
  try {
    const alice = await s.person()
    await s.register(alice, 'alice@example.test')
    await s.menu(alice, 'Organizations')
    await alice.fill('#o-name', 'Acme')
    await alice.getByRole('button', { name: 'Create', exact: true }).click()
    await alice.waitForSelector('#ork-title')
    await alice.getByLabel('I have stored it somewhere safe').check()
    await alice.getByRole('button', { name: 'Done' }).click()
    await s.manage(alice, 'Acme', 'Collections')
    await alice.fill('input[aria-label="New collection name"]', 'Ops')
    await alice.getByRole('button', { name: 'Add collection' }).click()
    await alice.waitForSelector('.collection-row:has-text("Ops")')

    await shareItem(s, alice, 'Router', 'password1')
    await shareItem(s, alice, 'Switch', 'password1')
    await shareItem(s, alice, 'Firewall', 'Zq8!vN3#pL6@wR1x-firewall-strong')

    await s.manage(alice, 'Acme', 'Password health')
    const card = alice.locator('.team-health')
    await card.locator('text=3 passwords in 1 collection you manage').waitFor()
    await card.locator('.health-collection', { hasText: 'Ops' }).locator('text=2 of 3 need attention').waitFor()
    const chips = (await card.locator('.health-counts .chip').allInnerTexts()).map((x) => x.replace(/\s+/g, ' ').trim())
    assert.ok(chips.includes('Weak 2') && chips.includes('Reused 2'), chips.join(' | '))
    const flagged = (await card.locator('.health-item .device-name').allInnerTexts()).sort()
    assert.deepEqual(flagged, ['Router', 'Switch'])

    // Filter by an issue.
    await card.locator('.health-counts .chip', { hasText: 'Reused' }).click()
    await card.locator('h3:has-text("Reused")').waitFor()
    assert.ok(!(await card.innerText()).includes('password1'), 'no password is shown')
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})
