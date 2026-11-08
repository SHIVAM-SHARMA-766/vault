// The notification centre (E10), access requests with check-outs (D7) and
// sensitive items (D12), between two people in two browsers.

import test from 'node:test'
import assert from 'node:assert/strict'

import { start } from './helpers.mjs'

async function orgsPage(s, page) {
  await s.menu(page, 'Organizations')
  await page.waitForSelector('h1:has-text("Organizations")')
}

async function openBell(page, s, email) {
  await page.reload(); await s.unlock(page, email)
  await page.getByRole('button', { name: /^Notifications/ }).click()
  await page.waitForSelector('.notes-pop')
}

test('invite, accept, ask for a collection, check it out, and a sensitive item opened — each one notified', async () => {
  const s = await start({ owner: 'alice@example.test' })
  try {
    const alice = await s.person()
    await s.register(alice, 'alice@example.test')
    await s.setRegistration(true)
    const bob = await s.person()
    await s.register(bob, 'bob@example.test')

    await orgsPage(s, alice)
    await alice.fill('#o-name', 'Acme')
    await alice.getByRole('button', { name: 'Create', exact: true }).click()
    await alice.waitForSelector('.org-card h2:has-text("Acme")')
    await alice.fill('input[aria-label="New collection name"]', 'Finance')
    await alice.getByRole('button', { name: 'Add collection' }).click()
    await alice.waitForSelector('.collection-row:has-text("Finance")')
    await alice.fill('input[aria-label="Email to invite"]', 'bob@example.test')
    await alice.fill('input[aria-label="Name for this member"]', 'Bob')
    await alice.getByRole('button', { name: 'Invite', exact: true }).click()
    await alice.waitForSelector('text=has not joined yet')

    // Bob: the invitation is in his notifications.
    await openBell(bob, s, 'bob@example.test')
    assert.match(await bob.getByRole('button', { name: /^Notifications/ }).getAttribute('aria-label'), /1 unread/)
    await bob.locator('.note', { hasText: 'You are invited to join Acme' }).click()
    await bob.waitForSelector('h1:has-text("Organizations")')
    await bob.getByRole('button', { name: 'Accept' }).click()
    await bob.waitForSelector('text=An admin must confirm you')

    // Alice: told to confirm him.
    await openBell(alice, s, 'alice@example.test')
    await alice.locator('.note', { hasText: 'Bob accepted your invitation' }).click()
    await alice.locator('.device-row', { hasText: 'Bob' }).getByRole('button', { name: 'Confirm…' }).click()
    await alice.getByRole('button', { name: 'It matches — confirm' }).click()
    await alice.waitForSelector('text=Bob confirmed', { state: 'attached' })

    // An item in Finance, marked sensitive.
    await s.menu(alice, 'Vault')
    await alice.click('.topbar .btn-primary')
    await alice.fill('#f-name', 'Payroll bank')
    await alice.fill('#f-password', 'Zq8!vN3#pL6@wR1x-payroll')
    await alice.click('.editor-foot .btn-primary')
    await alice.waitForSelector('.detail h2:has-text("Payroll bank")')
    await alice.locator('.detail-actions').getByRole('button', { name: 'Share', exact: true }).click()
    await alice.selectOption('select[aria-label="Collection"]', { label: 'Acme / Finance' })
    await alice.getByRole('button', { name: 'Move to collection' }).click()
    await alice.waitForSelector('.badge-shared:has-text("Acme / Finance")')
    // Ticked once the server has it, so click and wait for the badge.
    await alice.getByLabel('Tell the admins whenever someone opens this').click()
    await alice.waitForSelector('.badge-sensitive')

    // Bob asks for Finance, with a reason.
    await bob.reload(); await s.unlock(bob, 'bob@example.test')
    await orgsPage(s, bob)
    bob.once('dialog', (d) => d.accept('Month-end close'))
    await bob.locator('.collection-row', { hasText: 'Finance' }).getByRole('button', { name: 'Request access' }).click()
    await bob.waitForSelector('.collection-row:has-text("Finance") >> text=Access requested')

    // Alice approves for one hour from the request.
    await openBell(alice, s, 'alice@example.test')
    await alice.waitForSelector('.note:has-text("Bob asked for access to a collection: “Month-end close”")')
    await alice.locator('.note', { hasText: 'Bob asked for access' }).click()
    await alice.waitForSelector('.requests .device-row:has-text("Bob → Finance")')
    await alice.getByLabel('How long for Bob').selectOption('1')
    await alice.locator('.requests').getByRole('button', { name: 'Approve' }).click()
    await alice.waitForSelector('text=Bob can open Finance for 1 hour', { state: 'attached' })

    // Bob is told, opens the item; Alice is told he opened a sensitive item.
    await openBell(bob, s, 'bob@example.test')
    await bob.waitForSelector('.note:has-text("Your access request was approved, until")')
    await bob.keyboard.press('Escape')
    await s.menu(bob, 'Vault')
    await bob.getByRole('button', { name: /Finance/ }).click()
    await bob.locator('.row-item', { hasText: 'Payroll bank' }).click()
    await bob.waitForSelector('.detail .badge-sensitive')
    await bob.waitForTimeout(500)

    await openBell(alice, s, 'alice@example.test')
    await alice.waitForSelector('.note:has-text("Bob opened a sensitive item")')
    await alice.getByRole('button', { name: 'Mark all read' }).click()
    await alice.waitForSelector('.note.is-unread', { state: 'detached' })
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})
