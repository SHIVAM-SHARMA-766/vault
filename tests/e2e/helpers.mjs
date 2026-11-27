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
/** The account password (decisions/0036): step one of signing in. */
export const ACCOUNT_PASSWORD = 'a different account passphrase'

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
/** `edition`: personal, business or hosted (decisions/0030). Left out, the
 *  stack runs as an install that never set EDITION: every feature, and anyone
 *  may create an organization. */
export async function start({ owner = 'owner@example.test', edition, env = {} } = {}) {
  const port = await freePort()
  const base = `http://localhost:${port}`
  const stack = spawn(process.execPath, [`${ROOT}scripts/dev-stack.mjs`], {
    env: { ...process.env, PORT: String(port), OWNER_EMAIL: owner, ...(edition ? { EDITION: edition } : {}), ...env }, stdio: ['ignore', 'pipe', 'pipe'],
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
  async function person({ width = 1440, height = 900, scheme = 'light', bypassCSP = false, wizard = false, locale = 'en-US' } = {}) {
    // A distinct client address per person, as real people would have.
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, bypassCSP, locale, extraHTTPHeaders: { 'x-forwarded-for': `10.0.${people >> 8}.${++people & 255}` } })
    // The first-run setup wizard opens for a new server's owner; tests about
    // other things start with it already seen (wizard: true to test it).
    if (!wizard) await context.addInitScript(() => { try { localStorage.setItem('vault.setup-wizard.done', '1') } catch { /* no storage */ } })
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
    // With mail (DEV_MAIL), an account comes first, checked by an emailed code
    // (decisions/0037), then the vault.
    await page.locator('#su-email, #r-email').first().waitFor()
    if (await page.locator('#su-email').count()) return signupThenVault(page, email, inviteCode)
    if (inviteCode) {
      // On an open server the field is behind a link.
      await page.waitForSelector('#r-invite, button:has-text("I have an invitation code")')
      if (!(await page.locator('#r-invite').count())) await page.getByRole('button', { name: 'I have an invitation code' }).click()
      await page.fill('#r-invite', inviteCode)
    }
    await page.fill('#r-email', email)
    await page.fill('#r-account', ACCOUNT_PASSWORD)
    await page.fill('#r-account-confirm', ACCOUNT_PASSWORD)
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

  /** Signs in (decisions/0036): the account step when this browser is not
   *  signed in to that account, then the master password. */
  /** The newest sign-up code sent to an address (dev-stack outbox). */
  async function codeFor(email) {
    for (let i = 0; i < 40; i++) {
      const mail = (await (await fetch(`${base}/__dev/outbox`)).json()).filter((m) => m.to === email && /sign-up code/.test(m.subject)).at(-1)
      if (mail) return /\b(\d{6})\b/.exec(mail.text)[1]
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(`no sign-up code for ${email}`)
  }

  async function signupThenVault(page, email, inviteCode) {
    await page.fill('#su-email', email)
    await page.getByRole('button', { name: 'Send me a code' }).click()
    await page.waitForSelector('#su-code')
    await page.fill('#su-code', await codeFor(email))
    await page.fill('#su-pw', ACCOUNT_PASSWORD)
    await page.fill('#su-confirm', ACCOUNT_PASSWORD)
    await page.getByRole('button', { name: 'Create my account' }).click()
    await page.locator('#cv-pw, #vr-note').or(page.getByText('Your request was sent')).first().waitFor({ timeout: 60_000 })
    if (!(await page.locator('#cv-pw').count())) {
      if (!inviteCode) return null
      await page.getByRole('button', { name: 'I have an invitation code' }).click()
      await page.fill('#cv-code', inviteCode)
    }
    await page.fill('#cv-pw', PASSWORD)
    await page.fill('#cv-confirm', PASSWORD)
    await page.getByRole('button', { name: 'Create my vault' }).click()
    await page.waitForSelector('.recovery-key', { timeout: 60_000 })
    const recoveryKey = (await page.textContent('.recovery-key code'))?.trim()
    await page.check('.check input')
    await page.getByRole('button', { name: 'Open my vault' }).click()
    await page.waitForSelector('.topbar', { timeout: 60_000 })
    return recoveryKey
  }

  async function unlock(page, email, password = PASSWORD, { accountPassword = ACCOUNT_PASSWORD, wait = true } = {}) {
    await page.waitForSelector('#account-password, .account-line', { timeout: 30_000 })
    if (await page.locator('.account-line').count()) {
      const who = (await page.textContent('.account-line strong'))?.trim()
      if (who !== email) { await page.getByRole('button', { name: 'Not you? Sign out' }).click(); await page.waitForSelector('#account-password') }
    }
    if (await page.locator('#account-password').count()) {
      await page.fill('#email', email)
      await page.fill('#account-password', accountPassword)
      await page.click('button[type=submit]')
      await page.locator('.account-line, .alert-error, #tf-code').or(page.getByText('Use your passkey or security key')).first().waitFor({ timeout: 60_000 })
      if (!(await page.locator('.account-line').count())) return
    }
    await page.fill('#password', password)
    await page.click('button[type=submit]')
    if (wait) await page.waitForSelector('.topbar', { timeout: 60_000 })
  }

  /** Opens a screen from the account menu (Vault, Account settings, Admin
   *  console…). The names from before the admin console (decisions/0031)
   *  still work: Organizations is My organizations, Admin panel the console. */
  async function menu(page, item) {
    const name = { Organizations: 'My organizations', 'Admin panel': 'Admin console' }[item] ?? item
    await page.getByRole('button', { name: 'Account menu' }).click()
    await page.getByRole('menuitem', { name }).click()
  }

  /** Opens one section of an organization in the admin console (People —
   *  "Members" still works —, Groups, Collections, Policies, Activity,
   *  Recovery & backup). */
  async function manage(page, org, section = 'People') {
    if (section === 'Members') section = 'People'
    await menu(page, 'Admin console')
    await page.waitForSelector('.console-layout')
    const picker = page.locator('.sidebar select#scope')
    if (await picker.count()) await picker.selectOption({ label: org })
    else await page.locator('.sidebar .scope-name', { hasText: org }).waitFor()
    await page.locator('.console-layout .sidebar .side-item', { hasText: section }).click()
    await page.waitForSelector(`.console-org h1:has-text("${section}")`)
    await page.locator(`.admin-main .org-card[aria-label="${org}"]`).first().waitFor()
  }

  /** Opens a section of Account settings (Account, Security, Preferences,
   *  Emergency access): the sidebar on a wide screen, the chips on a phone. */
  async function settings(page, section = 'Account') {
    await menu(page, 'Account settings')
    await page.locator('.side-item:visible, .admin-chips .chip:visible', { hasText: section }).first().click()
    await page.waitForSelector(`.settings-head h1:has-text("${section}")`)
  }

  const setRegistration = (open) => fetch(`${base}/__dev/registration?open=${open ? 1 : 0}`, { method: 'POST' })
  /** Moves the server's clock on (dev stack only), to pass a time limit. */
  const skipMinutes = (minutes) => fetch(`${base}/__dev/clock?skip=${minutes}`, { method: 'POST' })

  async function stop() {
    await browser.close()
    stack.kill()
  }

  return { base, person, register, unlock, codeFor, signupThenVault, menu, manage, settings, setRegistration, skipMinutes, errors, stop, log: () => log }
}
