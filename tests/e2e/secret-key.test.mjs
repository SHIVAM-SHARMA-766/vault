// The opt-in secret key (decisions/0027): turned on in one browser, asked for
// once in another, a typo caught, a server that drops the flag refused, and
// turning it off again. Two accounts, because each sign-in spends two of an
// address's ten auth requests per 15 minutes.

import test from 'node:test'
import assert from 'node:assert/strict'

import { PASSWORD, start } from './helpers.mjs'

async function signIn(page, s, email) {
  await page.goto(`${s.base}/app/`)
  await page.fill('#email', email)
  await page.fill('#password', PASSWORD)
  await page.click('button[type=submit]')
}

/** Settings → Account → Add a secret key; returns the key from the kit. */
async function addSecretKey(page, s) {
  await s.settings(page, 'Account')
  await page.getByRole('button', { name: 'Add a secret key' }).click()
  await page.fill('#sk-password', PASSWORD)
  await page.locator('form[aria-labelledby="s-secret"]').getByRole('button', { name: 'Add a secret key' }).click()
  await page.waitForSelector('.emergency-kit', { timeout: 60_000 })
  const secretKey = (await page.textContent('.kit-secret'))?.trim()
  await page.getByLabel('I have stored my Emergency Kit somewhere safe.').check()
  await page.getByRole('button', { name: 'Done' }).click()
  await page.waitForSelector('#s-secret + .pill-ok')
  return secretKey
}

test('a secret key is asked for once on a new browser, and a typo is caught', async () => {
  const email = 'kit@example.test'
  const s = await start({ owner: email })
  try {
    const laptop = await s.person()
    await s.register(laptop, email)
    const secretKey = await addSecretKey(laptop, s)
    assert.match(secretKey, /^SK1(-[0-9A-Z]{4}){8}$/)

    // The same browser holds it: sign-in does not ask.
    await signIn(laptop, s, email)
    await laptop.waitForSelector('.topbar', { timeout: 60_000 })

    // A new browser is asked once; a typo is caught before anything is sent.
    const phone = await s.person()
    await signIn(phone, s, email)
    await phone.waitForSelector('text=This account uses a secret key')
    const typo = secretKey.slice(0, -1) + (secretKey.endsWith('A') ? 'B' : 'A')
    await phone.fill('#secret-key', typo)
    await phone.click('button[type=submit]')
    await phone.waitForSelector('text=That secret key has a typo')
    await phone.fill('#secret-key', secretKey.toLowerCase())
    await phone.click('button[type=submit]')
    await phone.waitForSelector('.topbar', { timeout: 60_000 })

    // Kept: the next sign-in on the phone does not ask again.
    await signIn(phone, s, email)
    await phone.waitForSelector('.topbar', { timeout: 60_000 })
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})

test('a server that drops the flag is refused, and removing the key is honoured', async () => {
  const email = 'kit2@example.test'
  const s = await start({ owner: email })
  try {
    const laptop = await s.person()
    await s.register(laptop, email)
    const secretKey = await addSecretKey(laptop, s)

    const phone = await s.person()
    await signIn(phone, s, email)
    await phone.waitForSelector('#secret-key')
    await phone.fill('#secret-key', secretKey)
    await phone.click('button[type=submit]')
    await phone.waitForSelector('.topbar', { timeout: 60_000 })

    // The server claims the account has no secret key: nothing is sent.
    await phone.route('**/api/auth/prelogin', async (route) => {
      const res = await route.fetch()
      const body = await res.json()
      delete body.kdf.version
      await route.fulfill({ response: res, json: body })
    })
    let sentLogin = false
    phone.on('request', (r) => { if (r.url().endsWith('/api/auth/login')) sentLogin = true })
    await signIn(phone, s, email)
    await phone.waitForSelector('text=the server says the account has none')
    assert.equal(sentLogin, false, 'no password-only auth key was sent')
    await phone.unroute('**/api/auth/prelogin')

    // Removed on the laptop (still signed in); the phone is told and can forget it.
    await laptop.getByRole('button', { name: 'Remove the secret key' }).click()
    await laptop.fill('#sk-password', PASSWORD)
    await laptop.getByRole('button', { name: 'Remove it' }).click()
    await laptop.waitForSelector('text=Secret key removed', { state: 'attached', timeout: 60_000 })

    await signIn(phone, s, email)
    await phone.waitForSelector('text=the server says the account has none')
    await phone.getByRole('button', { name: /forget the secret key on this browser/ }).click()
    await phone.click('button[type=submit]')
    await phone.waitForSelector('.topbar', { timeout: 60_000 })
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})
