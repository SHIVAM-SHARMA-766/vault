// Sharing one item with one person (D11), a rotation reminder on an item
// (D6), and the first-run setup wizard (A2).

import test from 'node:test'
import assert from 'node:assert/strict'

import { start } from './helpers.mjs'

test('share an item with one person: they accept, you confirm, they open it', async () => {
  const s = await start({ owner: 'alice@example.test' })
  try {
    const alice = await s.person()
    await s.register(alice, 'alice@example.test')
    await s.setRegistration(true)
    const bob = await s.person()
    await s.register(bob, 'bob@example.test')

    await alice.click('.topbar .btn-primary')
    await alice.fill('#f-name', 'Netflix')
    await alice.fill('#f-username', 'family@example.test')
    await alice.fill('#f-password', 'popcorn-Couch-Remote-Saturday-4')
    await alice.click('.editor-foot .btn-primary')
    await alice.waitForSelector('.detail h2:has-text("Netflix")')
    await alice.locator('.detail-actions').getByRole('button', { name: 'Share', exact: true }).click()
    await alice.getByLabel('Their email address').fill('bob@example.test')
    await alice.locator('.share-person').getByRole('button', { name: 'Share' }).click()
    await alice.waitForSelector('text=can open it after they accept and you confirm their fingerprint', { state: 'attached' })
    await alice.waitForSelector('.badge-shared:has-text("alice & bob")')

    await s.menu(bob, 'Organizations')
    await bob.getByRole('button', { name: 'Accept' }).click()
    await bob.waitForSelector('text=An admin must confirm you')

    await s.menu(alice, 'Organizations')
    await alice.waitForSelector('.org-card:has-text("Direct share")')
    await alice.locator('.device-row', { hasText: 'bob' }).getByRole('button', { name: 'Confirm…' }).click()
    await alice.getByRole('button', { name: 'It matches — confirm' }).click()
    await alice.waitForSelector('text=bob confirmed', { state: 'attached' })

    await bob.goto(`${s.base}/app/`); await s.unlock(bob, 'bob@example.test')
    await bob.getByRole('button', { name: /alice & bob/ }).click()
    await bob.locator('.row-item', { hasText: 'Netflix' }).click()
    await bob.waitForSelector('.detail h2:has-text("Netflix")')
    assert.match(await bob.textContent('.fields'), /family@example\.test/)
    assert.equal(await bob.locator('.detail-actions').getByRole('button', { name: 'Edit' }).isDisabled(), false, 'they can edit it too')

    // A second item to the same person goes into the same space, already open to them.
    await alice.locator('.brand').first().click()
    await alice.click('.topbar .btn-primary')
    await alice.fill('#f-name', 'Wi-Fi at home')
    await alice.click('.editor-foot .btn-primary')
    await alice.waitForSelector('.detail h2:has-text("Wi-Fi at home")')
    await alice.locator('.detail-actions').getByRole('button', { name: 'Share', exact: true }).click()
    await alice.getByLabel('Their email address').fill('bob@example.test')
    await alice.locator('.share-person').getByRole('button', { name: 'Share' }).click()
    await alice.waitForSelector('text=Shared with bob@example.test', { state: 'attached' })
    assert.equal(await alice.locator('.org-card').count() <= 1, true)
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})

test('a rotation reminder is kept on the item and shown with its next date', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await s.register(page, 'dev@example.test')
    await page.click('.topbar .btn-primary')
    await page.fill('#f-name', 'Payroll')
    await page.fill('#f-password', 'ledger-Quartz-Harbor-Pencil-8')
    await page.selectOption('#f-rotate', '90')
    await page.click('.editor-foot .btn-primary')
    await page.waitForSelector('.detail-foot:has-text("Change reminder every 90 days")')
    await page.locator('.detail-actions').getByRole('button', { name: 'Edit' }).click()
    assert.equal(await page.inputValue('#f-rotate'), '90')
  } finally {
    await s.stop()
  }
})

test('the setup wizard opens once for a new server and saves each step', async () => {
  const s = await start()
  try {
    const owner = await s.person({ wizard: true })
    await s.register(owner, 'owner@example.test')
    await s.menu(owner, 'Admin panel')
    await owner.waitForSelector('#wiz-title:has-text("What is this server called?")')
    await owner.fill('#wiz-name', 'Acme Vault')
    await owner.fill('#wiz-email', 'help@acme.example')
    await owner.getByRole('button', { name: 'Save and continue' }).click()
    await owner.waitForSelector('#wiz-title:has-text("Who can create an account?")')
    await owner.locator('.wizard').getByLabel(/People I invite/).check()
    await owner.getByRole('button', { name: 'Save and continue' }).click()
    await owner.waitForSelector('#wiz-title:has-text("Sign-in rules")')
    await owner.locator('.wizard').getByLabel('Require two-factor sign-in').check()
    await owner.getByRole('button', { name: 'Save and continue' }).click()
    await owner.waitForSelector('#wiz-title:has-text("Mail and backups")')
    await owner.getByRole('button', { name: 'Next' }).click()
    await owner.getByRole('button', { name: 'Done for now' }).click()
    await owner.waitForSelector('#wiz-title', { state: 'detached' })

    assert.equal(await owner.inputValue('#pf-name'), 'Acme Vault')
    assert.equal(await owner.getByRole('radio', { name: 'Invite only' }).getAttribute('aria-checked'), 'true')
    assert.equal(await owner.getByLabel('Require two-factor sign-in').isChecked(), true)

    await owner.reload(); await s.unlock(owner, 'owner@example.test')
    await owner.waitForSelector('#setup-title')
    assert.equal(await owner.locator('#wiz-title').count(), 0, 'not again once done')
    await owner.getByRole('button', { name: 'Step by step…' }).click()
    await owner.waitForSelector('#wiz-title')
  } finally {
    await s.stop()
  }
})
