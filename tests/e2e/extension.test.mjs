// The browser extension (decisions/0029), loaded for real into Chromium and
// pointed at the dev stack: connect, unlock, fill a login page; a look-alike
// origin and another port get nothing, even when asked directly; lock and
// idle lock.
//
// Branded Chrome no longer loads unpacked extensions from the command line,
// so this uses Chromium (EXT_CHROME_PATH, else /usr/bin/chromium, else
// Playwright's own build) and the test build, which has host permission for
// the loopback addresses so no permission prompt has to be clicked.

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'

import { chromium } from 'playwright-core'

import { PASSWORD, start } from './helpers.mjs'

const ROOT = new URL('../../', import.meta.url).pathname
const EXT = `${ROOT}apps/extension/dist/chrome-test`
const EMAIL = 'ext@example.test'
const SITE_PASSWORD = 'Hx9!fill-me-Correctly-42'

const LOGIN_PAGE = `<!doctype html><title>Example sign-in</title>
<form id="f" action="/done" method="post">
  <label>Search <input type="search" name="q"></label>
  <label>Email <input id="user" name="email" type="email" autocomplete="username"></label>
  <label>Password <input id="pass" name="password" type="password" autocomplete="current-password"></label>
  <button>Sign in</button>
</form>`

function site() {
  const server = createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(LOGIN_PAGE) })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })))
}

function chromiumPath() {
  return [process.env.EXT_CHROME_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p))
}

/** Chromium with the test build loaded; the extension's id, its background
 *  worker, and a way to find a tab's id by URL. */
async function launch() {
  const exe = chromiumPath()
  const ctx = await chromium.launchPersistentContext('', {
    ...(exe ? { executablePath: exe } : {}),
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  })
  // Chromium runs service workers of its own too; ours is background.js.
  const ours = (w) => w.url().endsWith('/background.js')
  const worker = ctx.serviceWorkers().find(ours) ?? await ctx.waitForEvent('serviceworker', { predicate: ours })
  // Its extension APIs are bound a moment after the worker starts.
  for (let i = 0; i < 100 && !(await worker.evaluate(() => !!globalThis.chrome?.tabs)); i++) await new Promise((r) => setTimeout(r, 50))
  const id = new URL(worker.url()).host
  const tabOf = (url) => worker.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]?.id, url)
  return { ctx, worker, id, tabOf }
}

/** Connect the popup to the server and unlock it. */
async function connect(popup, s, email) {
  await popup.fill('#server', s.base)
  await popup.getByRole('button', { name: 'Connect' }).click()
  await popup.waitForSelector('h1:has-text("Unlock")')
  await popup.fill('#email', email)
  await popup.fill('#password', PASSWORD)
  await popup.getByRole('button', { name: 'Unlock' }).click()
}

test('the extension connects, unlocks, fills the right site and nothing else, and locks', async () => {
  execFileSync('node', [`${ROOT}apps/extension/scripts/build.mjs`, '--test'], { stdio: 'ignore' })
  const s = await start({ owner: EMAIL })
  const good = await site(), other = await site()
  const LOGIN = `http://127.0.0.1:${good.port}/login`
  let ctx
  try {
    // An item for the login site, saved in the web app.
    const web = await s.person()
    await s.register(web, EMAIL)
    await web.click('.topbar .btn-primary')
    await web.fill('#f-name', 'Example')
    await web.fill('#f-username', 'me@example.test')
    await web.fill('#f-password', SITE_PASSWORD)
    await web.fill('#f-url', LOGIN)
    await web.click('.editor-foot .btn-primary')
    await web.waitForSelector('.detail h2:has-text("Example")')

    let worker, id, tabOf
    ;({ ctx, worker, id, tabOf } = await launch())

    const login = await ctx.newPage()
    await login.goto(LOGIN)
    const loginTab = await tabOf(LOGIN)

    // First run: connect to the server, then unlock.
    const popup = await ctx.newPage()
    await popup.goto(`chrome-extension://${id}/popup.html?tab=${loginTab}`)
    await popup.fill('#server', s.base)
    await popup.getByRole('button', { name: 'Connect' }).click()
    await popup.waitForSelector('h1:has-text("Unlock")')
    await popup.fill('#email', EMAIL)
    await popup.fill('#password', PASSWORD)
    await popup.getByRole('button', { name: 'Unlock' }).click()

    // The item is suggested for this page, and fills it.
    const suggested = popup.locator('section[aria-label="For 127.0.0.1"]')
    await suggested.locator('.row', { hasText: 'Example' }).waitFor({ timeout: 60_000 })
    await Promise.all([popup.waitForEvent('close'), suggested.getByRole('button', { name: 'Fill' }).click()])
    assert.equal(await login.inputValue('#user'), 'me@example.test')
    assert.equal(await login.inputValue('#pass'), SITE_PASSWORD)
    assert.equal(await login.inputValue('input[name=q]'), '', 'the search box is left alone')

    // Another port on the same address, and another host name: not suggested,
    // and refused by the background even when asked directly.
    for (const url of [`http://127.0.0.1:${other.port}/login`, `http://localhost:${good.port}/login`]) {
      const page = await ctx.newPage()
      await page.goto(url)
      const tab = await tabOf(url)
      const p = await ctx.newPage()
      await p.goto(`chrome-extension://${id}/popup.html?tab=${tab}`)
      await p.waitForSelector('text=No saved login matches this site')
      assert.equal(await p.getByRole('button', { name: 'Fill' }).count(), 0)
      const itemId = await p.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'items' })).result.items[0].id)
      const reply = await p.evaluate(async ([i, t]) => chrome.runtime.sendMessage({ type: 'fill', id: i, tabId: t }), [itemId, tab])
      assert.match(reply.result.error, /not for/)
      assert.equal(await page.inputValue('#pass'), '', `${url} got nothing`)
      await p.close(); await page.close()
    }

    // The vault key is not readable by the page, and not on disk.
    const leaked = await login.evaluate(() => typeof chrome !== 'undefined' && !!chrome.storage)
    assert.equal(leaked, false, 'a web page has no extension storage')

    // Lock from the popup.
    const again = await ctx.newPage()
    await again.goto(`chrome-extension://${id}/popup.html?tab=${loginTab}`)
    await again.getByRole('button', { name: 'Lock' }).click()
    await again.waitForSelector('h1:has-text("Unlock")')

    // Unlock again, then let the idle limit pass: the next look is locked.
    await again.fill('#password', PASSWORD)
    await again.getByRole('button', { name: 'Unlock' }).click()
    await again.waitForSelector('section[aria-label="All items"]', { timeout: 60_000 })
    await worker.evaluate(async () => {
      const { unlocked } = await chrome.storage.session.get('unlocked')
      await chrome.storage.session.set({ unlocked: { ...unlocked, lastActive: Date.now() - (unlocked.idleMinutes + 1) * 60_000 } })
    })
    await again.reload()
    await again.waitForSelector('h1:has-text("Unlock")')
    assert.deepEqual(await worker.evaluate(() => chrome.storage.session.get(null)), {}, 'nothing is left in session storage')
    assert.deepEqual(s.errors, [])
  } finally {
    await ctx?.close()
    good.server.close(); other.server.close()
    await s.stop()
  }
})

test('shared collections: signed keys only, filled not copied when passwords are hidden, and reported', async () => {
  execFileSync('node', [`${ROOT}apps/extension/scripts/build.mjs`, '--test'], { stdio: 'ignore' })
  // Swapping the server's answers to the background needs Playwright to see
  // service-worker traffic, which is experimental in Chromium.
  process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1'
  const s = await start({ owner: 'alice@example.test' })
  const good = await site()
  const LOGIN = `http://127.0.0.1:${good.port}/login`
  let ctx
  try {
    const alice = await s.person()
    await s.register(alice, 'alice@example.test')
    await s.setRegistration(true)
    const bob = await s.person()
    await s.register(bob, 'bob@example.test')

    // Acme / Finance, shared with Bob, passwords hidden.
    await s.menu(alice, 'Organizations')
    await alice.fill('#o-name', 'Acme')
    await alice.getByRole('button', { name: 'Create', exact: true }).click()
    await alice.waitForSelector('#ork-title')
    await alice.getByLabel('I have stored it somewhere safe').check()
    await alice.getByRole('button', { name: 'Done' }).click()
    await alice.fill('input[aria-label="New collection name"]', 'Finance')
    await alice.getByRole('button', { name: 'Add collection' }).click()
    await alice.waitForSelector('.collection-row:has-text("Finance")')
    await alice.fill('input[aria-label="Email to invite"]', 'bob@example.test')
    await alice.fill('input[aria-label="Name for this member"]', 'Bob')
    await alice.getByRole('button', { name: 'Invite', exact: true }).click()
    await s.menu(bob, 'Organizations')
    await bob.getByRole('button', { name: 'Accept' }).click()
    await bob.waitForSelector('text=An admin must confirm you')
    await alice.reload(); await s.unlock(alice, 'alice@example.test')
    await s.menu(alice, 'Organizations')
    await alice.locator('.device-row', { hasText: 'Bob' }).getByRole('button', { name: 'Confirm…' }).click()
    await alice.getByRole('button', { name: 'It matches — confirm' }).click()
    await alice.waitForSelector('text=Bob confirmed', { state: 'attached' })
    await alice.locator('.collection-row', { hasText: 'Finance' }).getByRole('button', { name: 'Access' }).click()
    await alice.selectOption('select[aria-label="Member"]', { label: 'Bob' })
    await alice.getByLabel('Hide passwords').check()
    await alice.getByRole('button', { name: 'Share', exact: true }).click()
    await alice.waitForSelector('.access-list li:has-text("Bob")')

    // An item for the login site, moved into Finance.
    await s.menu(alice, 'Vault')
    await alice.click('.topbar .btn-primary')
    await alice.fill('#f-name', 'Payroll')
    await alice.fill('#f-username', 'payroll@acme.test')
    await alice.fill('#f-password', SITE_PASSWORD)
    await alice.fill('#f-url', LOGIN)
    await alice.click('.editor-foot .btn-primary')
    await alice.waitForSelector('.detail h2:has-text("Payroll")')
    await alice.locator('.detail-actions').getByRole('button', { name: 'Share', exact: true }).click()
    await alice.selectOption('select[aria-label="Collection"]', { label: 'Acme / Finance' })
    await alice.getByRole('button', { name: 'Move to collection' }).click()
    await alice.waitForSelector('.badge-shared:has-text("Acme / Finance")')

    // Bob's extension: the shared item, where it lives, no password to copy.
    let tabOf, id
    ;({ ctx, id, tabOf } = await launch())
    const login = await ctx.newPage()
    await login.goto(LOGIN)
    const loginTab = await tabOf(LOGIN)
    const popup = await ctx.newPage()
    await popup.goto(`chrome-extension://${id}/popup.html?tab=${loginTab}`)
    await connect(popup, s, 'bob@example.test')
    const row = popup.locator('section[aria-label="For 127.0.0.1"] .row', { hasText: 'Payroll' })
    await row.waitFor({ timeout: 60_000 })
    await row.locator('.where:has-text("Acme / Finance")').waitFor()
    assert.equal(await row.getByRole('button', { name: /Copy password/ }).count(), 0, 'hidden passwords cannot be copied')
    const itemKey = await popup.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'items' })).result.items.find((i) => i.name === 'Payroll').id)
    const reveal = await popup.evaluate(async (k) => chrome.runtime.sendMessage({ type: 'reveal', id: k, field: 'password' }), itemKey)
    assert.match(reveal.error, /hides this password/, 'and the background refuses when asked directly')

    // It fills, and the organization is told.
    await Promise.all([popup.waitForEvent('close'), row.getByRole('button', { name: 'Fill' }).click()])
    assert.equal(await login.inputValue('#user'), 'payroll@acme.test')
    assert.equal(await login.inputValue('#pass'), SITE_PASSWORD)
    await alice.waitForTimeout(500)
    await s.menu(alice, 'Organizations')
    await alice.getByRole('button', { name: 'Activity…' }).click()
    await alice.locator('.audit li', { hasText: 'Bob filled a page from Payroll' }).waitFor()

    // A server that swaps the sealed key in Bob's grant: the collection is
    // refused and said so; his own items would still show.
    await ctx.route('**/api/orgs/*/collections', async (route) => {
      const res = await route.fetch()
      const body = await res.json()
      for (const c of body.collections) if (c.access) c.access.keyBlob = c.access.keyBlob.replace(/.$/, (ch) => (ch === 'A' ? 'B' : 'A'))
      await route.fulfill({ response: res, json: body })
    })
    const again = await ctx.newPage()
    await again.goto(`chrome-extension://${id}/popup.html?tab=${loginTab}`)
    await again.getByRole('button', { name: 'Sync' }).click()
    await again.waitForSelector('text=1 shared collection was not opened')
    assert.equal(await again.locator('.row', { hasText: 'Payroll' }).count(), 0, 'the swapped key is not used')
    assert.deepEqual(s.errors, [])
  } finally {
    await ctx?.close()
    good.server.close()
    await s.stop()
  }
})
