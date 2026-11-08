// Phase 3B step 5: a collection granted to a group reaches its members.

import test from 'node:test'
import assert from 'node:assert/strict'

import { start } from './helpers.mjs'

test('a group with a collection gives its members access', async () => {
  const s = await start()
  try {
    const alice = await s.person()
    await s.register(alice, 'alice@example.test')
    const bob = await s.person()
    await s.register(bob, 'bob@example.test')

    await s.menu(alice, 'Organizations')
    await alice.fill('#o-name', 'Acme')
    await alice.getByRole('button', { name: 'Create', exact: true }).click()
    // The organization's recovery key is shown once (decisions/0026).
    await alice.waitForSelector('#ork-title')
    await alice.getByLabel('I have stored it somewhere safe').check()
    await alice.getByRole('button', { name: 'Done' }).click()
    await alice.fill('input[aria-label="New collection name"]', 'Servers')
    await alice.getByRole('button', { name: 'Add collection' }).click()
    await alice.waitForSelector('.collection-row:has-text("Servers")')
    await alice.fill('input[aria-label="Email to invite"]', 'bob@example.test')
    await alice.fill('input[aria-label="Name for this member"]', 'Bob')
    await alice.getByRole('button', { name: 'Invite', exact: true }).click()

    await s.menu(bob, 'Organizations')
    await bob.getByRole('button', { name: 'Accept' }).click()
    await bob.waitForSelector('text=An admin must confirm you')

    await alice.reload(); await s.unlock(alice, 'alice@example.test'); await s.menu(alice, 'Organizations')
    await alice.locator('.device-row', { hasText: 'Bob' }).getByRole('button', { name: 'Confirm…' }).click()
    await alice.getByRole('button', { name: 'It matches — confirm' }).click()
    await alice.waitForSelector('.device-row:has-text("Bob") >> text=confirmed')

    // A group, given the collection, then Bob added to it.
    await alice.fill('input[aria-label="New group name"]', 'Engineering')
    await alice.getByRole('button', { name: 'Add group' }).click()
    await alice.waitForSelector('.group-row:has-text("Engineering")')
    await alice.locator('.collection-row', { hasText: 'Servers' }).getByRole('button', { name: 'Access' }).click()
    await alice.selectOption('select[aria-label="Group"]', { label: 'Engineering' })
    await alice.getByRole('button', { name: 'Share with group' }).click()
    await alice.waitForSelector('text=Group given access')
    await alice.selectOption('select[aria-label="Add to Engineering"]', { label: 'Bob' })
    await alice.locator('.group-row', { hasText: 'Engineering' }).getByRole('button', { name: 'Add', exact: true }).click()
    await alice.waitForSelector('.group-row:has-text("Engineering") .pill:has-text("Bob")')

    // The pill shows as soon as the server adds him; the keys are sealed to him
    // a moment later, so wait for the toast that says the group's access went through.
    await alice.waitForSelector('text=Bob added to Engineering', { state: 'attached' })
    await bob.reload(); await s.unlock(bob, 'bob@example.test')
    await s.menu(bob, 'Vault')
    await bob.getByRole('button', { name: /Servers/ }).waitFor({ timeout: 10_000 })
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})
