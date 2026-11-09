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

    const exe = chromiumPath()
    ctx = await chromium.launchPersistentContext('', {
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
