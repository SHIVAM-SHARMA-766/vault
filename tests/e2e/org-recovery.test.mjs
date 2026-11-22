// The organization recovery key (decisions/0026): shown once when an
// organization is created; a member who cannot open a collection uses it and
// becomes the owner, with the collection restored.

import test from 'node:test'
import assert from 'node:assert/strict'

import { start } from './helpers.mjs'

test('a member recovers an organization with its recovery key and opens what it held', async () => {
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
    const recoveryKey = (await alice.textContent('.recovery-key code')).trim()
    assert.ok(recoveryKey.length > 40)
    assert.equal(await alice.getByRole('button', { name: 'Done' }).isDisabled(), true, 'only once it is stored')
    await alice.getByLabel('I have stored it somewhere safe').check()
    await alice.getByRole('button', { name: 'Done' }).click()
    // Managed from the admin console (decisions/0031).
    await s.manage(alice, 'Acme', 'Recovery & backup')
    await alice.waitForSelector('text=Recovery key created')

    // A collection made after the key is covered by it.
    await s.manage(alice, 'Acme', 'Collections')
    await alice.fill('input[aria-label="New collection name"]', 'Finance')
    await alice.getByRole('button', { name: 'Add collection' }).click()
    await alice.waitForSelector('.collection-row:has-text("Finance")')
    await s.manage(alice, 'Acme', 'Recovery & backup')
    await alice.waitForSelector('text=covers 1 of 1 collection')
    await s.manage(alice, 'Acme', 'Members')
    await alice.fill('input[aria-label="Email to invite"]', 'bob@example.test')
    await alice.fill('input[aria-label="Name for this member"]', 'Bob')
    await alice.getByRole('button', { name: 'Invite', exact: true }).click()

    await s.menu(alice, 'Vault')
    await alice.click('.topbar .btn-primary')
    await alice.fill('#f-name', 'Treasury login')
    await alice.fill('#f-password', 'Zq8!vN3#pL6@wR1x-treasury')
    await alice.click('.editor-foot .btn-primary')
    await alice.waitForSelector('.detail h2:has-text("Treasury login")')
    await alice.locator('.detail-actions').getByRole('button', { name: 'Share', exact: true }).click()
    await alice.selectOption('select[aria-label="Collection"]', { label: 'Acme / Finance' })
    await alice.getByRole('button', { name: 'Move to collection' }).click()
    await alice.waitForSelector('.badge-shared:has-text("Acme / Finance")')

    // Bob joins but is never given Finance. Alice is "gone".
    await s.menu(bob, 'Organizations')
    await bob.getByRole('button', { name: 'Accept' }).click()
    await bob.waitForSelector('text=An admin must confirm you')

    // A wrong key is refused; the right one makes him the owner.
    await bob.getByRole('button', { name: /Recover with the recovery key/ }).click()
    await bob.fill('input[aria-label="Organization recovery key"]', 'ABCDE-FGHJK-MNPQR-STVWX-YZ234-56789-ABCDE')
    await bob.getByRole('button', { name: 'Recover', exact: true }).click()
    await bob.waitForSelector('text=not this organization', { state: 'attached' })
    await bob.fill('input[aria-label="Organization recovery key"]', recoveryKey)
    await bob.getByRole('button', { name: 'Recover', exact: true }).click()
    await bob.waitForSelector('text=You now own Acme: 1 of 1 collection(s) restored', { state: 'attached' })

    await s.menu(bob, 'Vault')
    await bob.getByRole('button', { name: /Finance/ }).click()
    await bob.locator('.row-item', { hasText: 'Treasury login' }).click()
    await bob.waitForSelector('.detail h2:has-text("Treasury login")')
    assert.deepEqual(s.errors.filter((e) => !/403/.test(e)), [])
  } finally {
    await s.stop()
  }
})
