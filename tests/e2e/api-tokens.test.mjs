// Admin API tokens (admin console phase 5): made in System, shown once,
// usable within their scopes from a script, and revoked.

import test from 'node:test'
import assert from 'node:assert/strict'

import { start } from './helpers.mjs'

test('an owner makes an API token, a script uses it, and revoking stops it', async () => {
  const s = await start()
  try {
    const owner = await s.person()
    await s.register(owner, 'owner@example.test')
    await s.menu(owner, 'Admin console')
    await owner.locator('.console-layout .sidebar .side-item', { hasText: 'System' }).click()
    await owner.waitForSelector('.api-tokens')
    assert.match(await owner.locator('.scim-url .recovery-key code').innerText(), /\/api\/scim\/v2$/)

    await owner.fill('#tok-name', 'Directory sync')
    await owner.getByRole('button', { name: 'Make token' }).click()
    await owner.locator('.api-tokens .issued code').first().waitFor()
    const token = (await owner.locator('.api-tokens .issued code').first().innerText()).trim()
    assert.match(token, /^vault_pat_/)

    // A directory lists users with it (the scim scope is on by default).
    const scim = await fetch(`${s.base}/api/scim/v2/Users`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(scim.status, 200)
    assert.equal((await scim.json()).totalResults, 1)

    await owner.getByRole('button', { name: 'Done' }).click()
    await owner.waitForSelector('td:has-text("Directory sync")')
    owner.once('dialog', (d) => d.accept())
    await owner.getByRole('button', { name: 'Revoke Directory sync' }).click()
    await owner.waitForSelector('text=Token revoked', { state: 'attached' })
    assert.equal((await fetch(`${s.base}/api/scim/v2/Users`, { headers: { authorization: `Bearer ${token}` } })).status, 401)
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})
