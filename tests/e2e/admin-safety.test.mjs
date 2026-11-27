// Admin safety (admin console phase 3): after ten minutes, a sensitive action
// asks for the master password, then goes ahead.

import test from 'node:test'
import assert from 'node:assert/strict'

import { PASSWORD, start } from './helpers.mjs'

test('a role change after ten minutes asks for the master password, then goes ahead', async () => {
  const s = await start()
  try {
    const owner = await s.person()
    await s.register(owner, 'owner@example.test')
    const bob = await s.person()
    await s.register(bob, 'bob@example.test')

    await s.menu(owner, 'Admin console')
    await owner.locator('.console-layout .sidebar .side-item', { hasText: 'Users' }).click()
    await owner.getByRole('button', { name: 'Open bob@example.test' }).click()
    await owner.waitForSelector('.drawer select[aria-label="Role"]')

    await s.skipMinutes(11)
    await owner.selectOption('.drawer select[aria-label="Role"]', 'viewer')
    await owner.waitForSelector('#reauth-password')
    // A wrong password is said so, and nothing changes.
    await owner.fill('#reauth-password', 'not my master password')
    await owner.getByRole('button', { name: 'Confirm' }).click()
    await owner.waitForSelector('text=That master password is not right.')
    await owner.fill('#reauth-password', PASSWORD)
    await owner.getByRole('button', { name: 'Confirm' }).click()
    await owner.waitForSelector('text=Role set to Viewer', { state: 'attached' })
    assert.equal(await owner.locator('#reauth-password').count(), 0)
    // Confirmed: the next one does not ask.
    await owner.selectOption('.drawer select[aria-label="Role"]', 'support')
    await owner.waitForSelector('text=Role set to Support', { state: 'attached' })
    assert.equal(await owner.locator('#reauth-password').count(), 0)
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})
