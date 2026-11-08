// Accessibility: axe-core (WCAG 2.1 A and AA rules) on every screen, light
// and dark. The test context bypasses the CSP only so axe itself can be
// injected; the app is unchanged.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import { start } from './helpers.mjs'

const require = createRequire(import.meta.url)
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8')

async function audit(page, name, found) {
  await page.waitForTimeout(300)
  await page.evaluate(AXE)
  const result = await page.evaluate(async () => {
    // eslint-disable-next-line no-undef
    const r = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }))
  })
  for (const v of result) found.push({ screen: name, ...v })
}

test('every screen passes axe-core WCAG 2.1 AA, light and dark', async () => {
  const s = await start({ owner: 'owner@example.test' })
  const found = []
  try {
    for (const scheme of ['light', 'dark']) {
      const page = await s.person({ scheme, bypassCSP: true })
      for (const path of ['/', '/features', '/security', '/faq', '/get']) { await page.goto(`${s.base}${path}`); await audit(page, `${scheme} site ${path}`, found) }
      // A share link's landing page (no account; the link here is made up, so it stays on the landing step).
      await page.goto(`${s.base}/app/s/AAAAAAAAAAAAAAAAAAAAAA#${'A'.repeat(43)}`)
      await page.waitForSelector('text=Someone shared an item with you')
      await audit(page, `${scheme} share link`, found)
      // Closed (once an account exists): sign-in offers a request for access.
      if (scheme === 'light') { const first = await s.person(); await s.register(first, 'first@example.test') }
      await s.setRegistration(false)
      await page.goto(`${s.base}/app/`)
      await audit(page, `${scheme} sign-in`, found)
      await page.getByRole('button', { name: 'Request access' }).click()
      await audit(page, `${scheme} request access`, found)
      // Open: sign-up.
      await s.setRegistration(true)
      await page.goto(`${s.base}/app/`)
      await page.getByRole('button', { name: 'Create an account' }).click()
      await audit(page, `${scheme} register`, found)
      await page.getByRole('button', { name: 'Back to sign in' }).click()

      const email = scheme === 'light' ? 'owner@example.test' : `dark-${Date.now()}@example.test`
      await s.register(page, email)
      await audit(page, `${scheme} empty vault`, found)
      await page.click('.topbar .btn-primary')
      await page.fill('#f-name', 'Example')
      await page.fill('#f-password', 'summer2024')
      await audit(page, `${scheme} editor`, found)
      await page.click('.editor-foot .btn-primary')
      await page.waitForSelector('.detail h2')
      await audit(page, `${scheme} vault with an item`, found)
      await page.getByRole('button', { name: /Password health/ }).click()
      await audit(page, `${scheme} health`, found)
      for (const section of ['Account', 'Security', 'Preferences', 'Backups', 'Emergency access']) {
        await s.settings(page, section)
        await page.waitForTimeout(300)
        await audit(page, `${scheme} settings ${section}`, found)
      }
      for (const item of ['Import & export', 'Organizations', 'Help & support']) {
        await s.menu(page, item)
        await page.waitForTimeout(300)
        await audit(page, `${scheme} ${item}`, found)
      }
      if (scheme === 'light') {
        await s.menu(page, 'Admin panel')
        await page.waitForSelector('.admin-section')
        for (const tab of ['Overview', 'Service desk', 'Website', 'Users', 'Organizations', 'Invitations', 'Audit log']) {
          await page.locator('.sidebar .side-item', { hasText: tab }).click()
          await page.waitForTimeout(400)
          await audit(page, `admin ${tab}`, found)
        }
      }
    }
  } finally {
    await s.stop()
  }
  const summary = found.map((v) => `${v.screen}: [${v.impact}] ${v.id} — ${v.help} — ${v.nodes.join(' | ')}`)
  if (summary.length) console.log(summary.join('\n'))
  assert.deepEqual(summary, [])
})
