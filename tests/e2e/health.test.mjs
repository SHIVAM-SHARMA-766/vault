// Phase 1: password health — weak, reused and unencrypted-site findings,
// computed in the browser, and cleared by fixing the entry.

import test from 'node:test'
import assert from 'node:assert/strict'

import { start } from './helpers.mjs'

async function addLogin(page, name, password, url) {
  await page.click('.topbar .btn-primary')
  await page.fill('#f-name', name)
  await page.fill('#f-password', password)
  await page.fill('#f-url', url)
  await page.click('.editor-foot .btn-primary')
  await page.waitForSelector(`.detail h2:has-text("${name}")`)
}

test('health finds weak, reused and http passwords, and fixing one clears it', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await s.register(page, 'lena@example.test')
    await addLogin(page, 'Forum', 'password1', 'http://forum.example')
    await addLogin(page, 'Shop', 'password1', 'https://shop.example')
    await addLogin(page, 'Bank', 'k9#Vt2!mQz@Lr8&w', 'https://bank.example')

    await page.getByRole('button', { name: /Password health/ }).click()
    await page.waitForSelector('.health-score')
    assert.equal(await page.textContent('.health-score strong'), '33')
    assert.equal(await page.locator('.row-item').count(), 2)
    await page.locator('.health-summary .chip', { hasText: 'Unencrypted site' }).click()
    assert.equal(await page.locator('.row-item').count(), 1)

    // The entry says what is wrong and what to do.
    await page.locator('.row-item', { hasText: 'Forum' }).click()
    const advice = await page.textContent('.health-issues')
    assert.match(advice, /Weak\./)
    assert.match(advice, /Reused\./)
    assert.match(advice, /Unencrypted site\./)

    // Fix Shop: a strong, unique password removes it from the list.
    await page.locator('.health-summary .chip', { hasText: 'All issues' }).click()
    await page.locator('.row-item', { hasText: 'Shop' }).click()
    await page.getByRole('button', { name: 'Edit' }).click()
    await page.fill('#f-password', 'Zq8!vN3#pL6@wR1x')
    await page.click('.editor-foot .btn-primary')
    await page.waitForFunction(() => document.querySelectorAll('.row-item').length === 1)
    assert.equal(await page.textContent('.health-score strong'), '67')
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})
