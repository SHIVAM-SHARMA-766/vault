// Phase 1: signed-in devices (list, name, sign out) and security activity,
// through the real client and API.

import test from 'node:test'
import assert from 'node:assert/strict'

import { start } from './helpers.mjs'

test('devices are listed, can be named and signed out, and activity is shown', async () => {
  const s = await start()
  try {
    const laptop = await s.person()
    await s.register(laptop, 'kai@example.test')
    const phone = await s.person({ width: 400, height: 860 })
    await phone.goto(`${s.base}/app/`)
    await s.unlock(phone, 'kai@example.test')

    await s.settings(laptop, 'Security')
    await laptop.waitForSelector('.device-row >> nth=1')
    assert.equal(await laptop.locator('.device-row').count(), 2)
    assert.equal(await laptop.locator('.device-row').first().locator('.pill', { hasText: 'This device' }).count(), 1)

    // Name this device.
    await laptop.locator('.device-row').first().getByRole('button', { name: /^Rename/ }).click()
    await laptop.fill('input[aria-label="Device name"]', 'Work laptop')
    await laptop.getByRole('button', { name: 'Save' }).click()
    await laptop.waitForSelector('.device-name:has-text("Work laptop")')

    // Sign the other one out.
    await laptop.locator('.device-row').nth(1).getByRole('button', { name: 'Sign out device' }).click()
    await laptop.waitForFunction(() => document.querySelectorAll('.device-row').length === 1)

    // Activity lists the sign-ins and the sign-out.
    await laptop.reload()
    await s.unlock(laptop, 'kai@example.test')
    await s.settings(laptop, 'Security')
    await laptop.waitForSelector('.activity-list li')
    const activity = await laptop.textContent('.activity-list')
    assert.match(activity, /Account created/)
    assert.match(activity, /Signed in/)
    assert.match(activity, /A device was signed out/)
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})
