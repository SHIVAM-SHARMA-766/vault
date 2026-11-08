// Shared set-up for the browser tests: a dev stack on a free port, a real
// Chrome, and the few steps every test repeats.
//
// Chrome is the one already on the machine (CHROME_PATH, or the usual paths);
// playwright-core drives it and downloads nothing.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { chromium } from 'playwright-core'

const ROOT = new URL('../../', import.meta.url).pathname
export const PASSWORD = 'a long and unguessable passphrase'

function chromePath() {
  const candidates = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  const found = candidates.find((p) => p && existsSync(p))
  if (!found) throw new Error('no Chrome found; set CHROME_PATH')
  return found
}

const freePort = () => new Promise((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})

/** Starts a dev stack and a browser. Returns helpers and a stop(). */
export async function start({ owner = 'owner@example.test' } = {}) {
  const port = await freePort()
  const base = `http://localhost:${port}`
  const stack = spawn(process.execPath, [`${ROOT}scripts/dev-stack.mjs`], {
    env: { ...process.env, PORT: String(port), OWNER_EMAIL: owner }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  stack.stdout.on('data', (d) => { log += d })
  stack.stderr.on('data', (d) => { log += d })
  for (let i = 0; i < 50 && !log.includes('dev stack on'); i++) await new Promise((r) => setTimeout(r, 100))
  if (!log.includes('dev stack on')) { stack.kill(); throw new Error(`dev stack did not start:\n${log}`) }

  const browser = await chromium.launch({ executablePath: chromePath(), args: ['--no-sandbox'] })
  const errors = []
  let people = 0

  /** A fresh, isolated browser profile — one per person in a test. */
  async function person({ width = 1440, height = 900, scheme = 'light', bypassCSP = false } = {}) {
    // A distinct client address per person, as real people would have.
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, bypassCSP, extraHTTPHeaders: { 'x-forwarded-for': `10.0.${people >> 8}.${++people & 255}` } })
    const page = await context.newPage()
    page.on('pageerror', (e) => errors.push(String(e)))
    page.on('console', (m) => {
      // 4xx responses the test provokes on purpose show up as console errors.
      if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) errors.push(m.text())
    })
    return page
  }

  /** Signs up; returns the recovery key shown once. */
  async function register(page, email, inviteCode) {
    await page.goto(`${base}/app/`)
    await page.getByRole('button', { name: 'Create an account' }).click()
    if (inviteCode) await page.fill('#r-invite', inviteCode)
    await page.fill('#r-email', email)
    await page.fill('#r-password', PASSWORD)
    await page.fill('#r-confirm', PASSWORD)
    await page.click('button[type=submit]')
    await page.waitForSelector('.recovery-key', { timeout: 60_000 })
    const recoveryKey = (await page.textContent('.recovery-key code'))?.trim()
    await page.check('.check input')
    await page.getByRole('button', { name: 'Continue to sign in' }).click()
    await unlock(page, email)
    return recoveryKey
  }

  async function unlock(page, email, password = PASSWORD) {
    await page.fill('#email', email)
    await page.fill('#password', password)
    await page.click('button[type=submit]')
    await page.waitForSelector('.topbar', { timeout: 60_000 })
  }

  /** Opens a screen from the account menu (Vault, Account settings, Admin panel). */
  async function menu(page, item) {
    await page.getByRole('button', { name: 'Account menu' }).click()
    await page.getByRole('menuitem', { name: item }).click()
  }

  /** Opens a section of Account settings (Account, Security, Preferences,
   *  Emergency access): the sidebar on a wide screen, the chips on a phone. */
  async function settings(page, section = 'Account') {
    await menu(page, 'Account settings')
    await page.locator('.side-item:visible, .admin-chips .chip:visible', { hasText: section }).first().click()
    await page.waitForSelector(`.settings-head h1:has-text("${section}")`)
  }

  const setRegistration = (open) => fetch(`${base}/__dev/registration?open=${open ? 1 : 0}`, { method: 'POST' })

  async function stop() {
    await browser.close()
    stack.kill()
  }

  return { base, person, register, unlock, menu, settings, setRegistration, errors, stop, log: () => log }
}
