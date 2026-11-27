// Related items: link an item to others from the editor; the item page lists
// them both ways and opens them; unlinking removes the link.

import test from 'node:test'
import assert from 'node:assert/strict'

import { start } from './helpers.mjs'

async function add(page, type, name, extra = async () => {}) {
  await page.click('.topbar .btn-primary')
  await page.selectOption('#f-type', type)
  await page.fill('#f-name', name)
  await extra()
  await page.click('.editor-foot .btn-primary')
  await page.waitForSelector(`.detail h2:has-text("${name}")`)
}

test('a server linked to its SSH key shows each on the other, and the link can be removed', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await s.register(page, 'rel@example.test')
    await add(page, 'sshKey', 'Prod deploy key')
    await add(page, 'note', 'Lunch menu')
    await add(page, 'server', 'Prod web 1', async () => {
      await page.fill('#f-related', 'deploy')
      await page.locator('.related-matches button', { hasText: 'Prod deploy key' }).click()
      assert.equal(await page.locator('.related-chips li').count(), 1)
      await page.fill('#f-related', 'zzz')
      await page.waitForSelector('.related-search >> text=No matching item.')
      await page.fill('#f-related', '')
    })

    const tiles = page.locator('.detail .related .tile')
    assert.deepEqual(await tiles.locator('.tile-name').allTextContents(), ['Prod deploy key'])
    await tiles.first().click()
    await page.waitForSelector('.detail h2:has-text("Prod deploy key")')
    assert.deepEqual(await page.locator('.detail .related .tile-name').allTextContents(), ['Prod web 1'], 'the link reads both ways')

    await page.locator('.detail .related .tile').first().click()
    await page.waitForSelector('.detail h2:has-text("Prod web 1")')
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByRole('button', { name: 'Unlink Prod deploy key' }).click()
    await page.click('.editor-foot .btn-primary')
    await page.waitForSelector('.detail h2:has-text("Prod web 1")')
    assert.equal(await page.locator('.detail .related').count(), 0)
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})
