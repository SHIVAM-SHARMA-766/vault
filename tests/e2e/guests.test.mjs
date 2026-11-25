// Guests (decisions/0032, 2d), in the browser: invited as a guest with an end
// date, confirmed, given one collection; the guest sees only that, cannot ask
// for others, and has no admin console.

import test from 'node:test'
import assert from 'node:assert/strict'

import { start } from './helpers.mjs'

test('a guest sees only the collection given to them, with the end date, and nothing to manage', async () => {
  const s = await start({ owner: 'alice@example.test' })
  try {
    const alice = await s.person()
    await s.register(alice, 'alice@example.test')
    await s.setRegistration(true)
    const gus = await s.person()
    await s.register(gus, 'gus@example.test')

    await s.menu(alice, 'Organizations')
    await alice.fill('#o-name', 'Acme')
    await alice.getByRole('button', { name: 'Create', exact: true }).click()
    await alice.waitForSelector('#ork-title')
    await alice.getByLabel('I have stored it somewhere safe').check()
    await alice.getByRole('button', { name: 'Done' }).click()
    await s.manage(alice, 'Acme', 'Collections')
    for (const name of ['Finance', 'Ops']) {
      await alice.fill('input[aria-label="New collection name"]', name)
      await alice.getByRole('button', { name: 'Add collection' }).click()
      await alice.waitForSelector(`.collection-row:has-text("${name}")`)
    }

    // Invited as a guest, until a date.
    await s.manage(alice, 'Acme', 'People')
    await alice.fill('input[aria-label="Email to invite"]', 'gus@example.test')
    await alice.fill('input[aria-label="Name for this member"]', 'Gus (auditor)')
    await alice.selectOption('select[aria-label="Invite as"]', 'guest')
    const until = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10)
    await alice.fill('#guest-until', until)
    await alice.getByRole('button', { name: 'Invite', exact: true }).click()
    await alice.waitForSelector('text=has not joined yet')

    await s.menu(gus, 'Organizations')
    await gus.locator('section:has(#o-inv)').locator('text=as guest').waitFor()
    await gus.locator('section:has(#o-inv)').getByRole('button', { name: 'Accept', exact: true }).click()
    await gus.waitForSelector('text=An admin must confirm you')

    await alice.reload(); await s.unlock(alice, 'alice@example.test')
    await s.manage(alice, 'Acme', 'People')
    const row = alice.locator('.device-row', { hasText: 'Gus (auditor)' })
    await row.locator('text=/guest · until/').waitFor()
    await row.getByRole('button', { name: 'Confirm…' }).click()
    await alice.getByRole('button', { name: 'It matches — confirm' }).click()
    await alice.waitForSelector('text=Gus (auditor) confirmed', { state: 'attached' })
    await s.manage(alice, 'Acme', 'Collections')
    await alice.locator('.collection-row', { hasText: 'Finance' }).getByRole('button', { name: 'Access' }).click()
    await alice.selectOption('select[aria-label="Member"]', { label: 'Gus (auditor)' })
    await alice.selectOption('select[aria-label="Permission set"]', { label: 'Use only' })
    await alice.getByRole('button', { name: 'Share', exact: true }).click()
    await alice.locator('.access-list li', { hasText: 'Gus' }).waitFor()

    // The guest's view.
    await gus.reload(); await s.unlock(gus, 'gus@example.test')
    await s.menu(gus, 'Organizations')
    const card = gus.locator('.org-card', { hasText: 'Acme' })
    await card.locator('.pill:has-text("Guest until")').waitFor()
    await card.locator('.collection-row', { hasText: 'Finance' }).waitFor()
    assert.equal(await card.locator('.collection-row', { hasText: 'Ops' }).count(), 0, 'not the other collection')
    assert.equal(await card.getByRole('button', { name: 'Request access' }).count(), 0)
    assert.equal(await card.locator('text=If every owner is locked out').count(), 0)
    assert.equal(await gus.locator('.workspace-switch').count(), 0, 'no admin console')
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})
