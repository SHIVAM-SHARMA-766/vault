// Notes in Markdown: drawn as headings, lists and checklists with ordinary
// elements; links open only for http(s); plain notes stay plain; the editor
// previews. Nothing in a note becomes markup.

import test from 'node:test'
import assert from 'node:assert/strict'

import { start } from './helpers.mjs'

const NOTE = [
  '# Office router',
  'Admin page: [open it](https://192.0.2.1.example/admin) or [this](javascript:alert(1))',
  '',
  '- [x] change default password',
  '- [ ] update firmware',
  '',
  '<img src=x onerror=alert(1)> **bold**',
].join('\n')

test('a note in Markdown is drawn safely, previews in the editor, and plain notes stay plain', async () => {
  const s = await start()
  try {
    const page = await s.person()
    let dialogs = 0
    page.on('dialog', (d) => { dialogs++; void d.dismiss() })
    await s.register(page, 'md@example.test')

    await page.click('.topbar .btn-primary')
    await page.selectOption('#f-type', 'note')
    await page.fill('#f-name', 'Router notes')
    await page.fill('#f-notes', NOTE)
    await page.getByRole('button', { name: 'Preview' }).click()
    await page.waitForSelector('.notes-preview h3:has-text("Office router")')
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.waitForSelector('#f-notes')
    await page.click('.editor-foot .btn-primary')
    await page.waitForSelector('.detail h2:has-text("Router notes")')

    const md = page.locator('.detail .markdown')
    await md.locator('h3', { hasText: 'Office router' }).waitFor()
    assert.equal(await md.locator('input[type=checkbox]').count(), 2)
    assert.equal(await md.locator('input[type=checkbox]:checked').count(), 1)
    assert.equal(await md.locator('strong', { hasText: 'bold' }).count(), 1)
    assert.equal(await md.locator('a').count(), 1, 'only the https link is a link')
    assert.equal(await md.locator('a').getAttribute('rel'), 'noopener noreferrer')
    assert.equal(await md.locator('img').count(), 0, 'markup in a note is text')
    assert.ok((await md.textContent()).includes('<img src=x onerror=alert(1)>'))

    await page.getByRole('button', { name: 'Show plain text' }).click()
    assert.equal(await page.locator('.detail .notes pre').textContent(), NOTE)

    await page.click('.topbar .btn-primary')
    await page.selectOption('#f-type', 'note')
    await page.fill('#f-name', 'Plain')
    await page.fill('#f-notes', 'PIN 4821, ask for Ravi')
    await page.click('.editor-foot .btn-primary')
    await page.waitForSelector('.detail h2:has-text("Plain")')
    assert.equal(await page.locator('.detail .markdown').count(), 0)
    assert.equal(await page.locator('.detail .notes pre').textContent(), 'PIN 4821, ask for Ravi')
    assert.equal(dialogs, 0)
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})
