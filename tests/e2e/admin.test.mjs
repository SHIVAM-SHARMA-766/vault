// The admin panel: roles, invitations, and publishing the website — including
// that what an editor types is shown as text and never run.

import test from 'node:test'
import assert from 'node:assert/strict'

import { ACCOUNT_PASSWORD, start } from './helpers.mjs'

async function invite(page, label, role) {
  await page.getByRole('button', { name: 'Invitations' }).first().click()
  await page.fill('#inv-label', label)
  await page.selectOption('#inv-role', role)
  await page.getByRole('button', { name: 'Create invitation' }).click()
  const code = await page.textContent('.issued code')
  await page.getByRole('button', { name: 'Done' }).click()
  return code
}

test('roles see what they should, and a marketing edit goes live escaped', async () => {
  const s = await start()
  try {
    const owner = await s.person()
    await s.register(owner, 'owner@example.test')
    await s.setRegistration(false)
    await s.menu(owner, 'Admin panel')
    await owner.waitForSelector('.stats')
    await owner.getByRole('radio', { name: 'Invite only' }).click()
    const marketingCode = await invite(owner, 'SEO agency', 'marketing')
    const viewerCode = await invite(owner, 'Investor', 'viewer')

    // Without a code, sign-up cannot be sent: on an invite-only server the
    // code is required, and the sign-in screen says an invitation is needed.
    const stranger = await s.person()
    await stranger.goto(`${s.base}/app/`)
    await stranger.waitForSelector('.auth-switch:has-text("Have an invitation?")')
    await stranger.getByRole('button', { name: 'Create an account' }).click()
    await stranger.fill('#r-email', 'stranger@example.test')
    await stranger.fill('#r-account', ACCOUNT_PASSWORD)
    await stranger.fill('#r-account-confirm', ACCOUNT_PASSWORD)
    await stranger.fill('#r-password', 'a long and unguessable passphrase')
    await stranger.fill('#r-confirm', 'a long and unguessable passphrase')
    await stranger.click('button[type=submit]')
    assert.equal(await stranger.locator('#r-invite:invalid').count(), 1)
    assert.equal(await stranger.locator('.topbar').count(), 0)

    const seo = await s.person()
    await s.register(seo, 'seo@example.test', marketingCode)
    await s.menu(seo, 'Admin panel')
    await seo.waitForSelector('.site-editor')
    const seoTabs = await seo.locator('.sidebar .side-item span').allTextContents()
    assert.deepEqual(seoTabs, ['Website'])

    await seo.fill('#f-home-hero-titleAccent', '<script>alert(1)</script>')
    await seo.getByRole('button', { name: 'Save draft' }).click()
    await seo.getByRole('button', { name: 'Publish', exact: true }).click()
    await seo.getByRole('button', { name: 'Publish now' }).click()
    await seo.waitForSelector('text=Published — live now')
    // The render lands on disk a moment after the panel says so; poll briefly
    // rather than race it.
    let home = ''
    for (let i = 0; i < 40 && !home.includes('alert(1)'); i++) {
      home = await (await fetch(`${s.base}/`)).text()
      if (!home.includes('alert(1)')) await new Promise((r) => setTimeout(r, 250))
    }
    assert.ok(home.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
    assert.ok(!home.includes('<script>alert(1)'))

    const viewer = await s.person()
    await s.register(viewer, 'investor@example.test', viewerCode)
    await s.menu(viewer, 'Admin panel')
    await viewer.waitForSelector('.stats')
    await viewer.getByRole('button', { name: 'Website' }).first().click()
    await viewer.waitForSelector('.site-editor')
    assert.equal(await viewer.isDisabled('#f-home-hero-titleAccent'), true)
    assert.equal(await viewer.getByRole('button', { name: 'Publish', exact: true }).count(), 0)

    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})

test('signing in at /app/admin says where it leads, and switching back to the vault keeps it unlocked', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await page.goto(`${s.base}/app/admin`)
    assert.equal(await page.textContent('.auth-title'), 'Sign in to the admin console')
    assert.equal(await page.getAttribute('.auth-home', 'href'), '/')
    await page.getByRole('button', { name: 'Create an account' }).click()
    await page.fill('#r-email', 'owner@example.test')
    await page.fill('#r-account', ACCOUNT_PASSWORD)
    await page.fill('#r-account-confirm', ACCOUNT_PASSWORD)
    await page.fill('#r-password', 'a long and unguessable passphrase')
    await page.fill('#r-confirm', 'a long and unguessable passphrase')
    await page.click('button[type=submit]')
    await page.waitForSelector('.recovery-key', { timeout: 60_000 })
    await page.check('.check input')
    await page.getByRole('button', { name: 'Continue to sign in' }).click()
    await s.unlock(page, 'owner@example.test').catch(() => {})
    await page.waitForSelector('.stats', { timeout: 60_000 })
    // The two workspaces (decisions/0031): back to the vault without a reload.
    await page.locator('.workspace-switch a', { hasText: 'My vault' }).click()
    await page.waitForSelector('.list-head')
    assert.ok(page.url().endsWith('/app/'))
  } finally {
    await s.stop()
  }
})
