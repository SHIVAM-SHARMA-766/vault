// Over plain http on a real hostname the browser withholds Web Crypto, so the
// app says why instead of failing during sign-in (docs/no-domain.md).

import test from 'node:test'
import assert from 'node:assert/strict'

import { existsSync } from 'node:fs'
import { chromium } from 'playwright-core'

import { start } from './helpers.mjs'

const chrome = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p))

test('plain http on a hostname explains that Vault needs https', async () => {
  const s = await start()
  // A name that is not localhost, resolved to this machine: not a secure origin.
  const browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox', '--host-resolver-rules=MAP vault-insecure.test 127.0.0.1'] })
  try {
    const page = await browser.newPage()
    const port = new URL(s.base).port
    await page.goto(`http://vault-insecure.test:${port}/app/`)
    await page.waitForSelector('text=This browser cannot run Vault here')
    assert.match(await page.locator('[role=alert] code').textContent(), /^http:\/\/vault-insecure\.test:/)
    assert.equal(await page.locator('#email').count(), 0, 'no sign-in form to fail in')
  } finally {
    await browser.close()
    await s.stop()
  }
})
