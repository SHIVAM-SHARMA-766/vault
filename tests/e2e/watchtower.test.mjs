// Breach check and the health dashboard (D5): a password found in a breach
// list is flagged after the person asks for a check; only 5-character hash
// prefixes reach the stand-in breach service; expired and expiring items are
// listed beside password issues.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

import { start } from './helpers.mjs'

const BREACHED = 'Summer-Holiday-2019!'
const SAFE = 'violet-Tractor-Mango-Lantern-41'
const sha1 = (s) => createHash('sha1').update(s).digest('hex').toUpperCase()

test('a breached password is found on request; expiry shows beside it; only prefixes leave', async () => {
  const asked = []
  const hibp = createServer((req, res) => {
    asked.push(req.url)
    const h = sha1(BREACHED)
    res.end(req.url.endsWith(h.slice(0, 5)) ? `${h.slice(5)}:4242\r\n` : '')
  })
  await new Promise((r) => hibp.listen(0, '127.0.0.1', r))
  process.env.BREACH_CHECK_URL = `http://127.0.0.1:${hibp.address().port}/range/`
  const s = await start()
  try {
    const page = await s.person()
    await s.register(page, 'dev@example.test')
    for (const [name, pw] of [['Old forum', BREACHED], ['Bank', SAFE]]) {
      await page.click('.topbar .btn-primary')
      await page.fill('#f-name', name)
      await page.fill('#f-password', pw)
      await page.click('.editor-foot .btn-primary')
      await page.waitForSelector(`.detail h2:has-text("${name}")`)
    }
    await page.click('.topbar .btn-primary')
    await page.selectOption('#f-type', 'passport')
    await page.fill('#f-name', 'Passport')
    await page.fill('#f-expires', '2021-01-31')
    await page.click('.editor-foot .btn-primary')
    await page.waitForSelector('.detail h2:has-text("Passport")')

    await page.getByRole('button', { name: /^Password health/ }).click()
    await page.getByRole('button', { name: 'Expired 1' }).click()
    await page.waitForSelector('.row-item:has-text("Passport")')
    assert.equal(await page.locator('.row-item').count(), 1)

    await page.getByRole('button', { name: 'Check for breaches' }).click()
    await page.waitForSelector('text=1 password was found in known breaches')
    await page.getByRole('button', { name: 'Breached 1' }).click()
    await page.waitForSelector('.row-item:has-text("Old forum")')
    assert.equal(await page.locator('.row-item').count(), 1)
    await page.locator('.row-item', { hasText: 'Old forum' }).click()
    await page.waitForSelector('.health-issues >> text=appears in known data breaches')

    assert.ok(asked.length >= 1 && asked.every((u) => /^\/range\/[0-9A-F]{5}$/.test(u)), `only prefixes: ${asked}`)
    assert.ok(!asked.some((u) => u.includes(sha1(BREACHED).slice(5))), 'never the suffix')
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
    delete process.env.BREACH_CHECK_URL
    hibp.close()
  }
})
