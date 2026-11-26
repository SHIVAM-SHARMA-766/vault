// People in organizations: a group chosen at invite time is joined at
// confirmation (B2); removing someone lists the shared passwords they could
// see until each is changed (B9); offboarding and sending an invitation again
// from the admin panel; branding (B3).

import test from 'node:test'
import assert from 'node:assert/strict'

import { start } from './helpers.mjs'

async function orgsPage(s, page) {
  await s.menu(page, 'Organizations')
  await page.waitForSelector('h1:has-text("My organizations")')
}

test('group on invite, then removal lists the passwords to change until they are changed', async () => {
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
    // The organization's recovery key is shown once (decisions/0026).
    await alice.waitForSelector('#ork-title')
    await alice.getByLabel('I have stored it somewhere safe').check()
    await alice.getByRole('button', { name: 'Done' }).click()
    await alice.waitForSelector('.org-card h2:has-text("Acme")')
    // Managed from the admin console (decisions/0031).
    await s.manage(alice, 'Acme', 'Collections')
    await alice.fill('input[aria-label="New collection name"]', 'Finance')
    await alice.getByRole('button', { name: 'Add collection' }).click()
    await alice.waitForSelector('.collection-row:has-text("Finance")')
    await s.manage(alice, 'Acme', 'Groups')
    await alice.fill('input[aria-label="New group name"]', 'Engineering')
    await alice.getByRole('button', { name: 'Add group' }).click()
    await alice.waitForSelector('.group-row:has-text("Engineering")')

    // Invite Bob into Engineering.
    await s.manage(alice, 'Acme', 'Members')
    await alice.waitForSelector('.invite-groups')
    await alice.fill('input[aria-label="Email to invite"]', 'bob@example.test')
    await alice.fill('input[aria-label="Name for this member"]', 'Bob')
    await alice.locator('.invite-groups').getByLabel('Engineering').check()
    await alice.getByRole('button', { name: 'Invite', exact: true }).click()
    await alice.waitForSelector('text=will join Engineering')

    await orgsPage(s, bob)
    await bob.getByRole('button', { name: 'Accept' }).click()
    await bob.waitForSelector('text=An admin must confirm you')

    await alice.reload(); await s.unlock(alice, 'alice@example.test')
    await s.manage(alice, 'Acme', 'Members')
    await alice.locator('.device-row', { hasText: 'Bob' }).getByRole('button', { name: 'Confirm…' }).click()
    await alice.getByRole('button', { name: 'It matches — confirm' }).click()
    await alice.waitForSelector('text=Bob confirmed and added to 1 group', { state: 'attached' })

    // Give Bob Finance and put a password in it.
    await s.manage(alice, 'Acme', 'Collections')
    await alice.locator('.collection-row', { hasText: 'Finance' }).getByRole('button', { name: 'Access' }).click()
    await alice.selectOption('select[aria-label="Member"]', { label: 'Bob' })
    await alice.getByRole('button', { name: 'Share', exact: true }).click()
    await alice.waitForSelector('.access-list li:has-text("Bob")')
    await s.menu(alice, 'Vault')
    await alice.click('.topbar .btn-primary')
    await alice.fill('#f-name', 'Bank portal')
    await alice.fill('#f-password', 'Zq8!vN3#pL6@wR1x-long-enough')
    await alice.click('.editor-foot .btn-primary')
    await alice.waitForSelector('.detail h2:has-text("Bank portal")')
    await alice.getByRole('button', { name: 'Share', exact: true }).click()
    await alice.selectOption('select[aria-label="Collection"]', { label: 'Acme / Finance' })
    await alice.getByRole('button', { name: 'Move to collection' }).click()
    await alice.waitForSelector('.badge-shared:has-text("Acme / Finance")')

    // Remove Bob: the password he could see is listed to change.
    await s.manage(alice, 'Acme', 'Members')
    alice.once('dialog', (d) => d.accept())
    await alice.getByRole('button', { name: 'Remove Bob' }).click()
    await alice.waitForSelector('text=1 password they could see is listed in Password health', { state: 'attached' })
    await s.menu(alice, 'Vault')
    await alice.getByRole('button', { name: /^Password health/ }).click()
    await alice.getByRole('button', { name: 'Seen by someone who left 1' }).click()
    await alice.locator('.row-item', { hasText: 'Bank portal' }).click()
    await alice.waitForSelector('.health-issues >> text=has left the organization')

    // Changing the password clears it.
    await alice.locator('.detail-actions').getByRole('button', { name: 'Edit' }).click()
    await alice.fill('#f-password', 'a-brand-new-Password-after-Bob-9')
    await alice.click('.editor-foot .btn-primary')
    await alice.waitForSelector('.detail h2:has-text("Bank portal")')
    await alice.getByRole('button', { name: /^Password health/ }).click()
    await alice.waitForSelector('.health-chips button:has-text("Seen by someone who left"):disabled', { timeout: 15_000 })
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})

test('admin panel: offboard an account, send an invitation again, brand the server', async () => {
  const s = await start()
  try {
    const owner = await s.person()
    await s.register(owner, 'owner@example.test')
    await s.setRegistration(true)
    const dee = await s.person()
    await s.register(dee, 'dee@example.test')

    await s.menu(owner, 'Admin panel')
    await owner.locator('.sidebar .side-item', { hasText: 'Users' }).click()
    // Each account opens in a side panel that holds its actions.
    await owner.getByRole('button', { name: 'Open dee@example.test' }).click()
    owner.once('dialog', (d) => d.accept())
    await owner.getByRole('button', { name: /^Offboard/ }).click()
    await owner.waitForSelector('text=Offboarded: disabled, signed out', { state: 'attached' })
    await owner.waitForSelector('.drawer button:has-text("Enable")')
    await owner.keyboard.press('Escape')

    await owner.locator('.sidebar .side-item', { hasText: 'Invitations' }).click()
    await owner.fill('#inv-label', 'Eve')
    await owner.getByRole('button', { name: 'Create invitation' }).click()
    await owner.waitForSelector('td:has-text("Eve")')
    const firstCode = (await owner.locator('.issued code').first().textContent())?.trim()
    await owner.getByRole('button', { name: 'Send the invitation for Eve again' }).click()
    await owner.getByRole('dialog').getByRole('button', { name: 'Send again' }).click()
    await owner.waitForSelector('text=Sent again with a fresh code', { state: 'attached' })
    const secondCode = (await owner.locator('.issued code').first().textContent())?.trim()
    assert.notEqual(secondCode, firstCode)

    await owner.locator('.sidebar .side-item', { hasText: 'Overview' }).click()
    await owner.getByRole('radio', { name: 'Teal' }).click()
    await owner.setInputFiles('#pf-logo', { name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64') })
    await owner.waitForSelector('.logo-preview')
    await owner.locator('form[aria-labelledby=profile-title]').getByRole('button', { name: 'Save' }).click()
    await owner.waitForSelector('text=Name, support contact and branding saved', { state: 'attached' })

    const visitor = await s.person()
    await visitor.goto(`${s.base}/app/`)
    await visitor.waitForSelector('.brand-logo')
    assert.equal(await visitor.evaluate(() => document.documentElement.dataset.accent), 'teal')
  } finally {
    await s.stop()
  }
})
