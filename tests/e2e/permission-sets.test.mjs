// Permission sets (decisions/0032, 2b), in the browser: an admin makes a
// custom set in the console, gives it to a member, and the member's app keeps
// what it allows. A set in use cannot be removed.

import test from 'node:test'
import assert from 'node:assert/strict'

import { start } from './helpers.mjs'

test('a custom permission set: made, given, kept by the member\'s app, and kept while in use', async () => {
  const s = await start({ owner: 'alice@example.test' })
  try {
    const alice = await s.person()
    await s.register(alice, 'alice@example.test')
    await s.setRegistration(true)
    const bob = await s.person()
    await s.register(bob, 'bob@example.test')

    await s.menu(alice, 'Organizations')
    await alice.fill('#o-name', 'Acme')
    await alice.getByRole('button', { name: 'Create', exact: true }).click()
    await alice.waitForSelector('#ork-title')
    await alice.getByLabel('I have stored it somewhere safe').check()
    await alice.getByRole('button', { name: 'Done' }).click()
    await s.manage(alice, 'Acme', 'Collections')
    await alice.fill('input[aria-label="New collection name"]', 'Finance')
    await alice.getByRole('button', { name: 'Add collection' }).click()
    await alice.waitForSelector('.collection-row:has-text("Finance")')
    await s.manage(alice, 'Acme', 'People')
    await alice.fill('input[aria-label="Email to invite"]', 'bob@example.test')
    await alice.fill('input[aria-label="Name for this member"]', 'Bob')
    await alice.getByRole('button', { name: 'Invite', exact: true }).click()
    await s.menu(bob, 'Organizations')
    await bob.locator('section:has(#o-inv)').getByRole('button', { name: 'Accept', exact: true }).click()
    await bob.waitForSelector('text=An admin must confirm you')
    await alice.reload(); await s.unlock(alice, 'alice@example.test')
    await s.manage(alice, 'Acme', 'People')
    await alice.locator('.device-row', { hasText: 'Bob' }).getByRole('button', { name: 'Confirm…' }).click()
    await alice.getByRole('button', { name: 'It matches — confirm' }).click()
    await alice.waitForSelector('text=Bob confirmed', { state: 'attached' })

    // The built-in sets, and a custom one.
    await s.manage(alice, 'Acme', 'Permission sets')
    await alice.locator('.set-row', { hasText: 'Manager' }).waitFor()
    const names = (await alice.locator('.set-row .device-name').allInnerTexts()).map((x) => x.split('\n')[0].trim())
    assert.deepEqual(names, ['Use only', 'Viewer', 'Editor', 'Manager'])
    await alice.getByRole('button', { name: 'New permission set' }).click()
    await alice.fill('#set-name', 'Auditor')
    await alice.getByLabel('See and copy passwords (off: fill only)').uncheck()
    await alice.getByLabel('Fill pages with the browser extension').uncheck()
    await alice.getByLabel('Include items in organization backups').check()
    await alice.getByRole('button', { name: 'Save set' }).click()
    await alice.locator('.set-row', { hasText: 'Auditor' }).locator('text=fill passwords without seeing them').waitFor()

    // Given to Bob on Finance, with an item in it.
    await s.manage(alice, 'Acme', 'Collections')
    await alice.locator('.collection-row', { hasText: 'Finance' }).getByRole('button', { name: 'Access' }).click()
    await alice.selectOption('select[aria-label="Member"]', { label: 'Bob' })
    await alice.selectOption('select[aria-label="Permission set"]', { label: 'Auditor' })
    await alice.locator('.set-hint:has-text("Auditor:")').waitFor()
    await alice.getByRole('button', { name: 'Share', exact: true }).click()
    await alice.locator('.access-list li', { hasText: 'Bob' }).locator('text=Auditor').waitFor()
    await s.menu(alice, 'Vault')
    await alice.click('.topbar .btn-primary')
    await alice.fill('#f-name', 'Ledger')
    await alice.fill('#f-password', 'Kq7!ledger-Password-Long')
    await alice.click('.editor-foot .btn-primary')
    await alice.waitForSelector('.detail h2:has-text("Ledger")')
    await alice.locator('.detail-actions').getByRole('button', { name: 'Share', exact: true }).click()
    await alice.selectOption('select[aria-label="Collection"]', { label: 'Acme / Finance' })
    await alice.getByRole('button', { name: 'Move to collection' }).click()
    await alice.waitForSelector('.badge-shared:has-text("Acme / Finance")')

    // Bob sees the set's name, and the password is not shown to him.
    await bob.reload(); await s.unlock(bob, 'bob@example.test')
    await s.menu(bob, 'Organizations')
    await bob.locator('.collection-row', { hasText: 'Finance' }).locator('text=Auditor').waitFor()
    await s.menu(bob, 'Vault')
    await bob.getByRole('button', { name: /Finance/ }).click()
    await bob.locator('.row-item', { hasText: 'Ledger' }).click()
    await bob.waitForSelector('.detail h2:has-text("Ledger")')
    assert.ok(!(await bob.locator('.detail').innerText()).includes('Kq7!ledger'), 'the password is not revealed')

    // In use: it stays.
    await s.manage(alice, 'Acme', 'Permission sets')
    alice.once('dialog', (d) => d.accept())
    await alice.getByRole('button', { name: 'Remove Auditor' }).click()
    await alice.waitForSelector('text=This set is given in 1 place', { state: 'attached' })
    assert.equal(await alice.locator('.set-row', { hasText: 'Auditor' }).count(), 1)
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})
