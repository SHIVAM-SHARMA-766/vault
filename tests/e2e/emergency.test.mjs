// Phase 3B step 8: emergency access between two people, approved early.

import test from 'node:test'
import assert from 'node:assert/strict'

import { start } from './helpers.mjs'

test('a trusted contact requests access, is approved, and reads the vault read-only', async () => {
  const s = await start()
  try {
    const asha = await s.person()
    await s.register(asha, 'asha@example.test')
    await asha.click('.topbar .btn-primary')
    await asha.fill('#f-name', 'Bank of Pune')
    await asha.fill('#f-password', 'Zq8!vN3#pL6@wR1x')
    await asha.click('.editor-foot .btn-primary')
    await asha.waitForSelector('.detail h2:has-text("Bank of Pune")')

    const ravi = await s.person()
    await s.register(ravi, 'ravi@example.test')

    await s.menu(asha, 'Account settings')
    await asha.fill('#em-email', 'ravi@example.test')
    await asha.fill('#em-label', 'Ravi')
    await asha.fill('#em-from', 'Asha')
    await asha.getByRole('button', { name: 'Add trusted contact' }).click()
    await asha.waitForSelector('section[aria-labelledby="s-emergency"] .device-row:has-text("Ravi")')

    await s.menu(ravi, 'Account settings')
    await ravi.locator('section[aria-labelledby="s-emergency"]').getByRole('button', { name: 'Accept' }).click()
    await ravi.waitForSelector('text=Waiting for them to confirm you')
    const raviFp = (await ravi.textContent('.fingerprint code')).trim()

    await asha.reload(); await s.unlock(asha, 'asha@example.test'); await s.menu(asha, 'Account settings')
    await asha.locator('section[aria-labelledby="s-emergency"]').getByRole('button', { name: 'Confirm…' }).click()
    assert.equal((await asha.textContent('.confirm .fingerprint code')).trim(), raviFp)
    await asha.getByRole('button', { name: 'It matches — confirm' }).click()
    await asha.waitForSelector('text=Ravi can now request access')

    await ravi.reload(); await s.unlock(ravi, 'ravi@example.test'); await s.menu(ravi, 'Account settings')
    ravi.once('dialog', (d) => d.accept())
    await ravi.getByRole('button', { name: 'Request access' }).click()
    await ravi.waitForSelector('text=unless they reject it')

    await asha.reload(); await s.unlock(asha, 'asha@example.test'); await s.menu(asha, 'Account settings')
    await asha.waitForSelector('text=Someone has requested emergency access')
    await asha.getByRole('button', { name: 'Approve now' }).click()
    await asha.waitForSelector('text=Access approved')

    await ravi.reload(); await s.unlock(ravi, 'ravi@example.test'); await s.menu(ravi, 'Account settings')
    await ravi.getByRole('button', { name: 'Open (read only)' }).click()
    await ravi.waitForSelector('.emergency-view summary:has-text("Bank of Pune")')
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})
