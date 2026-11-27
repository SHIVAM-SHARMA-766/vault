// Item templates: made in Preferences, offered in New item, filling in their
// fields; items made from one are listed under it in the sidebar, and a new
// item there starts from it.

import test from 'node:test'
import assert from 'node:assert/strict'

import { start } from './helpers.mjs'

test('a template made in Preferences fills in its fields and gets its own sidebar entry', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await s.register(page, 'tpl@example.test')
    await s.settings(page, 'Preferences')
    const card = page.locator('section[aria-labelledby="p-templates"]')
    await card.getByRole('button', { name: 'New template' }).click()
    await card.getByRole('button', { name: 'Save template' }).click()
    await card.locator('text=Give the template a name.').waitFor()
    await page.fill('#tpl-name', 'Office laptop')
    await page.selectOption('#tpl-base', 'note')
    await page.fill('[aria-label="Field 1 label"]', 'Serial number')
    await card.getByRole('button', { name: 'Add a field' }).click()
    await page.fill('[aria-label="Field 2 label"]', 'BIOS password')
    await card.locator('.template-fields li').nth(1).getByText('Hidden').click()
    await card.getByRole('button', { name: 'Save template' }).click()
    await card.locator('.template-list li', { hasText: 'Office laptop' }).waitFor()
    assert.match(await card.locator('.template-list li').textContent(), /2 fields · from Secure note/)

    await s.menu(page, 'Vault')
    await page.click('.topbar .btn-primary')
    await page.selectOption('#f-type', { label: 'Office laptop' })
    assert.equal(await page.inputValue('[aria-label="Custom field 1 name"]'), 'Serial number')
    assert.equal(await page.inputValue('[aria-label="Custom field 2 name"]'), 'BIOS password')
    await page.fill('#f-name', 'ThinkPad X1')
    await page.fill('[aria-label="Custom field 1 value"]', 'PF-12345')
    await page.fill('[aria-label="Custom field 2 value"]', 'bios-secret-77')
    await page.click('.editor-foot .btn-primary')
    await page.waitForSelector('.detail h2:has-text("ThinkPad X1")')
    assert.ok((await page.textContent('.detail')).includes('PF-12345'))
    assert.ok(!(await page.textContent('.detail')).includes('bios-secret-77'), 'the hidden field is masked')

    // The sidebar lists the template; a new item there starts from it.
    await page.locator('.sidebar .side-item', { hasText: 'Office laptop' }).click()
    assert.equal(await page.locator('.row-item').count(), 1)
    await page.click('.topbar .btn-primary')
    assert.equal(await page.inputValue('[aria-label="Custom field 1 name"]'), 'Serial number')
    assert.equal(await page.locator('#f-type').inputValue(), (await page.locator('#f-type option', { hasText: 'Office laptop' }).getAttribute('value')))
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})
