// Screenshots for the documentation, taken from the real product.
//
//   npm run build && npm run screenshots
//
// Starts the in-memory dev stack (the same one the browser tests use), signs
// up a demo owner, imports a demo vault through the Import screen, and saves
// each main screen to docs/images/. Every value shown is made up. Re-run after
// a UI change so the docs never show an older product than the one that ships.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { start } from '../tests/e2e/helpers.mjs'

const ROOT = new URL('../', import.meta.url).pathname
const OUT = join(ROOT, 'docs/images')
mkdirSync(OUT, { recursive: true })

const OWNER = 'asha@example.com'

// A believable vault: folders, every importable type, a TOTP key for the live
// code, and a few problems for the health screen to find.
const DEMO = JSON.stringify({
  encrypted: false,
  folders: [
    { id: 'w', name: 'Work' }, { id: 'ws', name: 'Work/Servers' }, { id: 'p', name: 'Personal' }, { id: 'f', name: 'Finance' },
  ],
  items: [
    { type: 1, name: 'GitHub', folderId: 'w', favorite: true, login: { username: 'asha.dev', password: 'Vq7#rLz2!pN9@kT4', totp: 'JBSWY3DPEHPK3PXP', uris: [{ uri: 'https://github.com' }] }, notes: 'Personal access tokens are in the custom fields.', fields: [{ name: 'Deploy token', value: 'ghp_demo_not_a_real_token', type: 1 }] },
    { type: 1, name: 'AWS console', folderId: 'w', login: { username: 'asha@example.com', password: 'Mx4$Tq8!vR2#nB6z', uris: [{ uri: 'https://console.aws.amazon.com' }] } },
    { type: 1, name: 'Prod database', folderId: 'ws', login: { username: 'admin', password: 'Kp3@Wd7!sL9#xF2m', uris: [{ uri: 'https://db.internal.example' }] } },
    { type: 1, name: 'Grafana', folderId: 'ws', login: { username: 'asha', password: 'summer2024', uris: [{ uri: 'http://grafana.example.net' }] } },
    { type: 1, name: 'Jira', folderId: 'w', login: { username: 'asha@example.com', password: 'summer2024', uris: [{ uri: 'https://example.atlassian.net' }] } },
    { type: 1, name: 'Netflix', folderId: 'p', favorite: true, login: { username: 'asha@example.com', password: 'Hn5!cQ8@rZ3#wY7p', uris: [{ uri: 'https://www.netflix.com' }] } },
    { type: 1, name: 'Amazon', folderId: 'p', login: { username: 'asha@example.com', password: 'Bt6#mK9!qW2@sD4v', uris: [{ uri: 'https://www.amazon.in' }] } },
    { type: 1, name: 'Gmail', folderId: 'p', favorite: true, login: { username: 'asha@example.com', password: 'Fj8@pL3!tR6#yN1k', totp: 'KRSXG5CTMVRXEZLU', uris: [{ uri: 'https://mail.google.com' }] } },
    { type: 1, name: 'HDFC NetBanking', folderId: 'f', login: { username: 'cust1042', password: 'Zr2!vX7@hM5#qC9w', uris: [{ uri: 'https://netbanking.hdfcbank.com' }] } },
    { type: 3, name: 'HDFC Millennia', folderId: 'f', card: { cardholderName: 'Asha Rao', number: '4111111111111111', expMonth: '08', expYear: '2029', code: '123' } },
    { type: 4, name: 'Asha Rao', identity: { firstName: 'Asha', lastName: 'Rao', email: 'asha@example.com', phone: '+91 98765 43210', city: 'Pune', state: 'MH', country: 'India' } },
    { type: 2, name: 'Wi-Fi at home', folderId: 'p', notes: 'Network: RaoHome-5G\nPassword: in the router drawer' },
    { type: 2, name: 'Backup codes (2FA)', folderId: 'w', notes: '4f2a-9c1d\n8e7b-3a6f\n1d9c-5b2e' },
  ],
})

const s = await start({ owner: OWNER })
const shot = async (page, name, opts = {}) => {
  await page.waitForTimeout(350)
  await page.screenshot({ path: join(OUT, `${name}.png`), ...opts })
  console.log(`  ${name}.png`)
}

try {
  // The public website.
  const site = await s.person({ width: 1440, height: 900 })
  await site.goto(`${s.base}/`)
  await shot(site, 'website')

  // Sign-up's recovery key screen.
  const page = await s.person({ width: 1440, height: 900 })
  await page.goto(`${s.base}/app/`)
  await shot(page, 'sign-in')
  await s.register(page, OWNER)

  // Import the demo vault through the product's own Import screen.
  await s.menu(page, 'Import & export')
  await page.setInputFiles('.file-drop input', { name: 'bitwarden_export.json', mimeType: 'application/json', buffer: Buffer.from(DEMO) })
  await page.waitForSelector('text=was read as')
  await shot(page, 'import')
  await page.getByRole('button', { name: /^Import \d+ items/ }).click()
  await page.waitForSelector('.alert-ok')
  await page.getByRole('link', { name: 'Go to the vault' }).click()

  // The vault, with an entry open.
  await page.locator('.row-item', { hasText: 'GitHub' }).first().click()
  await page.waitForSelector('.detail h2:has-text("GitHub")')
  await shot(page, 'vault')

  await page.locator('.row-item', { hasText: 'HDFC Millennia' }).click()
  await page.waitForSelector('.detail h2:has-text("HDFC Millennia")')
  await shot(page, 'card')

  // Editing an entry keeps its history.
  await page.locator('.row-item', { hasText: 'AWS console' }).click()
  await page.getByRole('button', { name: 'Edit' }).click()
  await shot(page, 'editor')
  await page.fill('#f-password', 'Rw8!nK2@vT6#pM4q')
  await page.click('.editor-foot .btn-primary')
  await page.waitForSelector('.detail h2:has-text("AWS console")')
  await page.getByRole('button', { name: 'History' }).click()
  await page.locator('.history-row').first().click()
  await shot(page, 'history')

  // Password health.
  await page.getByRole('button', { name: /Password health/ }).click()
  await page.locator('.row-item', { hasText: 'Grafana' }).click()
  await shot(page, 'health')

  // Folders.
  await page.locator('.folder-item', { hasText: 'Work' }).first().locator('.side-item').click()
  await page.locator('.row-item', { hasText: 'Prod database' }).click()
  await shot(page, 'folders')

  // Settings: two-factor and devices.
  await s.menu(page, 'Account settings')
  await page.waitForSelector('.device-row')
  await shot(page, 'settings')
  await page.locator('#s-sessions').scrollIntoViewIfNeeded()
  await shot(page, 'devices')

  // The admin panel.
  await s.menu(page, 'Admin panel')
  await page.waitForSelector('.admin-section')
  await shot(page, 'admin')
  // A reload would lock the vault (keys live in memory only), so navigate in-app.
  await page.locator('.sidebar .side-item', { hasText: 'Website' }).click()
  await page.waitForSelector('.site-editor')
  await shot(page, 'admin-website')

  // Dark mode and a phone.
  const dark = await s.person({ width: 1440, height: 900, scheme: 'dark' })
  await dark.goto(`${s.base}/app/`)
  await s.unlock(dark, OWNER)
  await dark.locator('.row-item', { hasText: 'Gmail' }).click()
  await dark.waitForSelector('.detail h2:has-text("Gmail")')
  await shot(dark, 'vault-dark')

  const phone = await s.person({ width: 390, height: 844 })
  await phone.goto(`${s.base}/app/`)
  await s.unlock(phone, OWNER)
  await shot(phone, 'mobile-list')
  await phone.locator('.row-item', { hasText: 'Netflix' }).click()
  await phone.waitForSelector('.detail h2:has-text("Netflix")')
  await shot(phone, 'mobile-detail')

  if (s.errors.length) console.warn('page errors:', s.errors)
} finally {
  await s.stop()
}

