// Share links (D3): one person makes a link; someone with no account opens
// it in another browser; it stops working as promised; the owner sees it
// and can revoke a live one.

import test from 'node:test'
import assert from 'node:assert/strict'

import { start } from './helpers.mjs'

async function addLogin(page, name, username, password) {
  await page.click('.topbar .btn-primary')
  await page.fill('#f-name', name)
  await page.fill('#f-username', username)
  await page.fill('#f-password', password)
  await page.click('.editor-foot .btn-primary')
  await page.waitForSelector(`.detail h2:has-text("${name}")`)
}

async function makeLink(page, views) {
  await page.locator('.detail-actions').getByRole('button', { name: 'Share by link' }).click()
  await page.selectOption('#sl-views', views)
  await page.getByRole('button', { name: 'Create link' }).click()
  const input = page.getByLabel('Share link')
  await input.waitFor()
  const url = await input.inputValue()
  await page.getByRole('button', { name: 'Done' }).click()
  return url
}

test('a one-view link opens once in another browser with no account, then is used up', async () => {
  const s = await start()
  try {
    const owner = await s.person()
    await s.register(owner, 'owner@example.test')
    await addLogin(owner, 'Office printer', 'printer-admin', 'toner-Cartridge-42!')
    const url = await makeLink(owner, '1')
    assert.match(url, /\/app\/s\/[A-Za-z0-9_-]{22}#[A-Za-z0-9_-]{43}$/)

    const guest = await s.person()
    await guest.goto(url)
    await guest.waitForSelector('text=Someone shared an item with you')
    await guest.getByRole('button', { name: 'Open it' }).click()
    await guest.waitForSelector('h1:has-text("Office printer")')
    assert.match(await guest.textContent('.fields'), /printer-admin/)
    await guest.getByRole('button', { name: 'Reveal Password' }).click()
    assert.match(await guest.textContent('.fields'), /toner-Cartridge-42!/)
    await guest.waitForSelector('text=This was the last view')
    assert.ok(!guest.url().includes('#'), 'the key is taken out of the address once used')

    const late = await s.person()
    await late.goto(url)
    await late.getByRole('button', { name: 'Open it' }).click()
    await late.waitForSelector('text=This link has expired, was used up, or was revoked')

    // A link cut short before the # cannot even try.
    const cut = await s.person()
    await cut.goto(url.split('#')[0])
    await cut.waitForSelector('text=This link is incomplete')

    await s.settings(owner, 'Security')
    await owner.waitForSelector('#s-links')
    await owner.waitForSelector('.device-row:has-text("Office printer") >> text=Used up')
    await owner.waitForSelector('text=One of your share links was opened')
  } finally {
    await s.stop()
  }
})

test('a live link can be revoked from Settings, and then opens nothing', async () => {
  const s = await start()
  try {
    const owner = await s.person()
    await s.register(owner, 'owner@example.test')
    await addLogin(owner, 'Guest Wi-Fi note', 'guest', 'sunny-Morning-Coffee-7')
    const url = await makeLink(owner, '')
    await s.settings(owner, 'Security')
    await owner.getByRole('button', { name: 'Revoke link to Guest Wi-Fi note' }).click()
    await owner.waitForSelector('.device-row:has-text("Guest Wi-Fi note") >> text=Revoked')

    const guest = await s.person()
    await guest.goto(url)
    await guest.getByRole('button', { name: 'Open it' }).click()
    await guest.waitForSelector('text=This link has expired, was used up, or was revoked')
  } finally {
    await s.stop()
  }
})
