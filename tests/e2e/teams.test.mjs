// Phase 3B: two people share a collection. Alice creates an organization and a
// collection; Bob is invited, accepts, and is confirmed by fingerprint; Alice
// shares an item; Bob reads it (view only); Alice removes Bob and he loses it.

import test from 'node:test'
import assert from 'node:assert/strict'

import { start } from './helpers.mjs'

async function orgsPage(s, page) {
  await s.menu(page, 'Organizations')
  await page.waitForSelector('h1:has-text("Organizations")')
}

test('share a collection between two people, confirmed by fingerprint, then remove one', async () => {
  const s = await start()
  try {
    const alice = await s.person()
    await s.register(alice, 'alice@example.test')
    await orgsPage(s, alice)
    await alice.fill('#o-name', 'Acme')
    await alice.getByRole('button', { name: 'Create', exact: true }).click()
    await alice.waitForSelector('.org-card h2:has-text("Acme")')
    await alice.fill('input[aria-label="New collection name"]', 'Finance')
    await alice.getByRole('button', { name: 'Add collection' }).click()
    await alice.waitForSelector('.collection-row:has-text("Finance")')

    const bob = await s.person()
    await s.register(bob, 'bob@example.test')
    await alice.fill('input[aria-label="Email to invite"]', 'bob@example.test')
    await alice.fill('input[aria-label="Name for this member"]', 'Bob')
    await alice.getByRole('button', { name: 'Invite', exact: true }).click()
    await alice.waitForSelector('text=has not joined yet')

    // Bob accepts, and waits to be confirmed.
    await orgsPage(s, bob)
    await bob.waitForSelector('#o-inv')
    await bob.getByRole('button', { name: 'Accept' }).click()
    await bob.waitForSelector('text=An admin must confirm you')
    const bobFingerprint = (await bob.textContent('.fingerprint code')).trim()

    // Alice confirms him after comparing fingerprints.
    await alice.reload(); await s.unlock(alice, 'alice@example.test'); await orgsPage(s, alice)
    await alice.locator('.device-row', { hasText: 'Bob' }).getByRole('button', { name: 'Confirm…' }).click()
    assert.equal((await alice.textContent('.confirm .fingerprint code')).trim(), bobFingerprint, 'Alice sees exactly the fingerprint Bob reads out')
    await alice.getByRole('button', { name: 'It matches — confirm' }).click()
    await alice.waitForSelector('.device-row:has-text("Bob") >> text=confirmed')

    // Alice gives Bob view access to Finance.
    await alice.locator('.collection-row', { hasText: 'Finance' }).getByRole('button', { name: 'Access' }).click()
    await alice.selectOption('select[aria-label="Member"]', { label: 'Bob' })
    await alice.getByRole('button', { name: 'Share', exact: true }).click()
    await alice.waitForSelector('.access-list li:has-text("Bob")')

    // Alice moves a personal login into Finance.
    await s.menu(alice, 'Vault')
    await alice.click('.topbar .btn-primary')
    await alice.fill('#f-name', 'AWS root')
    await alice.fill('#f-password', 'Zq8!vN3#pL6@wR1x')
    await alice.click('.editor-foot .btn-primary')
    await alice.waitForSelector('.detail h2:has-text("AWS root")')
    await alice.getByRole('button', { name: 'Share' }).click()
    await alice.selectOption('select[aria-label="Collection"]', { label: 'Acme / Finance' })
    await alice.getByRole('button', { name: 'Move to collection' }).click()
    await alice.waitForSelector('.badge-shared:has-text("Acme / Finance")')

    // Bob sees it, decrypted, and view only.
    await bob.reload(); await s.unlock(bob, 'bob@example.test')
    await s.menu(bob, 'Vault')
    await bob.getByRole('button', { name: /Finance/ }).click()
    await bob.locator('.row-item', { hasText: 'AWS root' }).click()
    await bob.waitForSelector('.detail .badge:has-text("View only")')
    assert.equal(await bob.getByRole('button', { name: 'Edit' }).isDisabled(), true)

    // Alice removes Bob; he loses the collection. First, the audit shows he opened it.
    await orgsPage(s, alice)
    await alice.getByRole('button', { name: 'Activity…' }).click()
    await alice.waitForSelector('.audit li:has-text("Bob opened AWS root in Finance")')
    alice.once('dialog', (d) => d.accept())
    await alice.getByRole('button', { name: 'Remove Bob' }).click()
    // Removal re-keys the collection automatically: Bob's old key is retired.
    await alice.waitForSelector('text=1 of 1 collection key(s) rotated')
    assert.equal(await alice.locator('.collection-row:has-text("Key rotation due")').count(), 0)
    await s.menu(alice, 'Vault')
    await alice.getByRole('button', { name: /Finance/ }).click()
    await alice.locator('.row-item', { hasText: 'AWS root' }).click()
    await alice.waitForSelector('.detail h2:has-text("AWS root")')
    await bob.reload(); await s.unlock(bob, 'bob@example.test')
    await s.menu(bob, 'Vault')
    await bob.waitForSelector('.sidebar')
    assert.equal(await bob.getByRole('button', { name: /Finance/ }).count(), 0)
    assert.equal(await bob.locator('.row-item', { hasText: 'AWS root' }).count(), 0)
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})
