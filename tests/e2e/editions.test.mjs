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

test('a business Vault keeps organizations and the desk, without the website editor', async () => {
  const s = await start({ owner: 'it@example.test', edition: 'business' })
  try {
    const it = await s.person()
    await s.register(it, 'it@example.test')
    await s.menu(it, 'Admin panel')
    await it.waitForSelector('.sidebar .side-item')
    const tabs = (await it.locator('.sidebar .side-item').allInnerTexts()).map((x) => x.trim())
    assert.ok(tabs.includes('Organizations') && tabs.includes('Service desk') && tabs.includes('Invitations'), tabs.join(' | '))
    assert.ok(!tabs.includes('Website'), tabs.join(' | '))
    await s.menu(it, 'Organizations')
    await it.waitForSelector('h1:has-text("Organizations")')
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})
