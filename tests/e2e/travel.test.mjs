// Travel mode: mark what may travel, turn it on, and every other vault is gone
// from the app (and from the API every client uses) until it is turned off
// with the master password.

import test from 'node:test'
import assert from 'node:assert/strict'

import { PASSWORD, start } from './helpers.mjs'

async function addLogin(page, name) {
  await page.click('.topbar .btn-primary')
  await page.fill('#f-name', name)
  await page.fill('#f-password', `violet-Tractor-Mango-${name}`)
  await page.click('.editor-foot .btn-primary')
  await page.waitForSelector(`.detail h2:has-text("${name}")`)
}

test('travel mode hides vaults not marked safe until it is turned off with the master password', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await s.register(page, 'trip@example.test')
    await addLogin(page, 'Bank')
    await page.getByRole('button', { name: 'New vault' }).click()
    await page.fill('#fd-name', 'Holiday')
    await page.click('.modal .btn-primary')
    await page.waitForSelector('text=Vault “Holiday” created')
    await addLogin(page, 'Airline')

    await s.settings(page, 'Security')
    const card = page.locator('section[aria-labelledby="s-travel"]')
    await card.locator('.travel-vaults li', { hasText: 'Holiday' }).getByText('Safe for travel').click()
    await page.waitForSelector('text=Marked safe for travel')
    await card.locator('text=Turning it on removes “Personal”').waitFor()
    await card.getByRole('button', { name: 'Turn on travel mode' }).click()
    await page.waitForSelector('text=Travel mode is on.')

    await s.menu(page, 'Vault')
    await page.waitForSelector('.travel-banner')
    const names = await page.locator('.row-item .row-name').allTextContents()
    assert.deepEqual(names, ['Airline'], 'Personal is away')

    // Later than the sign-in's grace: turning it off asks for the password.
    await s.skipMinutes(11)
    await s.settings(page, 'Security')
    await card.getByRole('button', { name: 'Turn off travel mode' }).click()
    await page.waitForSelector('#reauth-password')
    await page.fill('#reauth-password', PASSWORD)
    await page.getByRole('button', { name: 'Confirm' }).click()
    await page.waitForSelector('text=Travel mode is off. Every vault is back.')
    await s.menu(page, 'Vault')
    await page.locator('.vault-switch .side-item', { hasText: 'All vaults' }).click()
    assert.deepEqual(await page.locator('.row-item .row-name').allTextContents(), ['Airline', 'Bank'])
    assert.equal(await page.locator('.travel-banner').count(), 0)
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})
