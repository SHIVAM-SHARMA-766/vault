// Editions (decisions/0030) in the browser. A personal Vault is one person's:
// no organizations, invitations, service desk, website, emergency access or
// sharing with a person, anywhere in the app, and no way in for anyone else.
// A business Vault keeps organizations but has no website editor.

import test from 'node:test'
import assert from 'node:assert/strict'

import { start } from './helpers.mjs'

test('a personal Vault shows only what one person needs', async () => {
  const s = await start({ owner: 'me@example.test', edition: 'personal' })
  try {
    const me = await s.person({ wizard: true })
    await s.register(me, 'me@example.test')

    // The setup wizard skips who-can-join and inviting people.
    await s.menu(me, 'Server settings')
    await me.waitForSelector('.wizard')
    const steps = await me.locator('.wizard-steps li').allInnerTexts()
    assert.deepEqual(steps.map((x) => x.trim()), ['Name', 'Sign-in rules', 'Mail and backups'])
    await me.getByRole('button', { name: /Finish later/ }).click()

    // The server panel: no users, invitations, organizations, desk or website.
    await me.waitForSelector('.sidebar .side-item')
    const tabs = (await me.locator('.sidebar .side-item').allInnerTexts()).map((x) => x.trim())
    assert.deepEqual(tabs, ['Overview', 'Audit log', 'System'])
    assert.equal(await me.locator('#reg-title').count(), 0, 'no registration setting')
    assert.equal(await me.getByText('Invite your first people').count(), 0)

    // The account menu and settings.
    await me.getByRole('button', { name: 'Account menu' }).click()
    const items = (await me.getByRole('menuitem').allInnerTexts()).map((x) => x.trim())
    assert.ok(!items.includes('Organizations') && !items.includes('Help & support') && !items.includes('Admin panel'), items.join(' | '))
    await me.keyboard.press('Escape')
    await s.menu(me, 'Account settings')
    assert.equal(await me.locator('.side-item', { hasText: 'Emergency access' }).count(), 0)

    // An item: share by link, but no sharing with a person.
    await s.menu(me, 'Vault')
    await me.click('.topbar .btn-primary')
    await me.fill('#f-name', 'Router')
    await me.fill('#f-password', 'Kq7!router-admin-Password')
    await me.click('.editor-foot .btn-primary')
    await me.waitForSelector('.detail h2:has-text("Router")')
    assert.equal(await me.locator('.detail-actions').getByRole('button', { name: 'Share', exact: true }).count(), 0)
    assert.equal(await me.locator('.detail-actions').getByRole('button', { name: 'Share by link' }).count(), 1)

    // A link to organizations opens the vault instead.
    await me.goto(`${s.base}/app/orgs`)
    await s.unlock(me, 'me@example.test')
    await me.waitForSelector('.detail h2, .row-item')
    assert.equal(await me.locator('h1:has-text("Organizations")').count(), 0)

    // Nobody else can join: the sign-in page offers no way in.
    const other = await s.person()
    await other.goto(`${s.base}/app/`)
    await other.waitForSelector('#email')
    assert.equal(await other.getByRole('button', { name: 'Create an account' }).count(), 0)
    assert.equal(await other.getByRole('button', { name: 'Request access' }).count(), 0)
    assert.equal(await other.getByRole('button', { name: /Ask for help/ }).count(), 0)
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})

test('a business Vault: one company, People, a sign-up code for a newcomer, Add to company', async () => {
  const s = await start({ owner: 'it@acme.test', edition: 'business' })
  try {
    const it = await s.person()
    await s.register(it, 'it@acme.test')

    // No company yet: the console says to create it.
    await s.menu(it, 'Admin console')
    await it.getByRole('link', { name: 'Create the company' }).click()
    await it.waitForSelector('#o-new:has-text("Create your company")')
    await it.fill('#o-name', 'Acme')
    await it.getByRole('button', { name: 'Create', exact: true }).click()
    await it.waitForSelector('#ork-title')
    await it.getByLabel('I have stored it somewhere safe').check()
    await it.getByRole('button', { name: 'Done' }).click()
    await it.waitForSelector('.console-org h1:has-text("People")')

    // The server scope no longer lists accounts, invitations or organizations; People does.
    await it.locator('.sidebar select#scope').selectOption({ label: 'This server (server)' })
    await it.waitForSelector('.sidebar .side-item')
    const tabs = (await it.locator('.sidebar .side-item').allInnerTexts()).map((x) => x.trim())
    for (const gone of ['Users', 'Invitations', 'Organizations', 'Website']) assert.ok(!tabs.includes(gone), tabs.join(' | '))

    // A newcomer with no account: one invitation, with a sign-up code.
    await s.manage(it, 'Acme', 'People')
    await it.fill('input[aria-label="Email to invite"]', 'newcomer@acme.test')
    await it.fill('input[aria-label="Name for this member"]', 'Nia')
    await it.getByRole('button', { name: 'Invite', exact: true }).click()
    await it.waitForSelector('.signup-code:has-text("Nia has no account yet")')
    const code = (await it.locator('.signup-code .recovery-key code').innerText()).trim()
    await it.locator('.signup-code').getByRole('button', { name: 'Done' }).click()

    const nia = await s.person()
    await s.register(nia, 'newcomer@acme.test', code)
    await s.menu(nia, 'Organizations')
    await nia.locator('section:has(#o-inv)').getByRole('button', { name: 'Accept', exact: true }).click()
    await nia.waitForSelector('text=An admin must confirm you')

    await s.manage(it, 'Acme', 'People')
    const row = it.locator('.device-row', { hasText: 'Nia' })
    await row.getByRole('button', { name: 'Confirm…' }).click()
    await it.getByRole('button', { name: 'It matches — confirm' }).click()
    await it.waitForSelector('text=Nia confirmed', { state: 'attached' })
    await row.locator('.account-facts:has-text("no two-factor")').waitFor()

    // An account already on the server, not in the company: Add to company.
    const bob = await s.person()
    await s.register(bob, 'bob@acme.test')
    await s.manage(it, 'Acme', 'Collections')
    await s.manage(it, 'Acme', 'People')
    const outside = it.locator('.outside-row')
    await outside.first().waitFor()
    assert.equal(await outside.count(), 1, 'only Bob is outside the company')
    await outside.getByRole('button', { name: 'Add to company' }).click()
    await it.waitForSelector('text=will see the invitation when they sign in', { state: 'attached' })
    await s.menu(bob, 'Organizations')
    await bob.locator('section:has(#o-inv)').getByRole('button', { name: 'Accept', exact: true }).waitFor()

    // One company: it is not offered again.
    await s.menu(it, 'Organizations')
    await it.locator('.org-card', { hasText: 'Acme' }).waitFor()
    assert.equal(await it.locator('#o-new').count(), 0)
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})
