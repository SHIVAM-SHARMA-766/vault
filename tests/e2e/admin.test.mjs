// The admin panel: roles, invitations, and publishing the website — including
// that what an editor types is shown as text and never run.

import test from 'node:test'
import assert from 'node:assert/strict'

import { start } from './helpers.mjs'

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
    await owner.getByRole('button', { name: 'Admin' }).click()
    await owner.waitForSelector('.stats')
    await owner.getByRole('radio', { name: 'Invite only' }).click()
    const marketingCode = await invite(owner, 'SEO agency', 'marketing')
    const viewerCode = await invite(owner, 'Investor', 'viewer')

    // Without a code, sign-up is refused.
    const stranger = await s.person()
    await stranger.goto(`${s.base}/app/`)
    await stranger.getByRole('button', { name: 'Create an account' }).click()
    await stranger.fill('#r-email', 'stranger@example.test')
    await stranger.fill('#r-password', 'a long and unguessable passphrase')
    await stranger.fill('#r-confirm', 'a long and unguessable passphrase')
    await stranger.click('button[type=submit]')
    await stranger.waitForSelector('.alert-error', { timeout: 60_000 })

    const seo = await s.person()
    await s.register(seo, 'seo@example.test', marketingCode)
    await seo.getByRole('button', { name: 'Admin' }).click()
    await seo.waitForSelector('.site-editor')
    const seoTabs = await seo.locator('.sidebar .side-item span').allTextContents()
    assert.deepEqual(seoTabs, ['Website'])

    await seo.fill('#f-home-hero-titleAccent', '<script>alert(1)</script>')
    await seo.getByRole('button', { name: 'Save draft' }).click()
    await seo.getByRole('button', { name: 'Publish', exact: true }).click()
    await seo.getByRole('button', { name: 'Publish now' }).click()
    await seo.waitForSelector('text=Published')
    const home = await (await fetch(`${s.base}/`)).text()
    assert.ok(home.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
    assert.ok(!home.includes('<script>alert(1)'))

    const viewer = await s.person()
    await s.register(viewer, 'investor@example.test', viewerCode)
    await viewer.getByRole('button', { name: 'Admin' }).click()
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

test('signing in at /app/admin says where it leads, and the breadcrumb keeps the vault unlocked', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await page.goto(`${s.base}/app/admin`)
    assert.equal(await page.textContent('.auth-title'), 'Sign in to the admin panel')
    assert.equal(await page.getAttribute('.auth-home', 'href'), '/')
    await page.getByRole('button', { name: 'Create an account' }).click()
    await page.fill('#r-email', 'owner@example.test')
    await page.fill('#r-password', 'a long and unguessable passphrase')
    await page.fill('#r-confirm', 'a long and unguessable passphrase')
    await page.click('button[type=submit]')
    await page.waitForSelector('.recovery-key', { timeout: 60_000 })
    await page.check('.check input')
    await page.getByRole('button', { name: 'Continue to sign in' }).click()
    await s.unlock(page, 'owner@example.test').catch(() => {})
    await page.waitForSelector('.stats', { timeout: 60_000 })
    await page.click('.crumbs-admin a')
    await page.waitForSelector('.list-head')
    assert.ok(page.url().endsWith('/app/'))
  } finally {
    await s.stop()
  }
})
