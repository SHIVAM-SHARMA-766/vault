// An account first, a vault later (decisions/0037), in the browser: sign up
// with an emailed code; with invitation-only registration, ask for a vault;
// the owner approves in the console, the person is emailed and creates it.

import test from 'node:test'
import assert from 'node:assert/strict'

import { ACCOUNT_PASSWORD, PASSWORD, start } from './helpers.mjs'

test('sign up with a code, ask for a vault, the owner approves, the person creates it', async () => {
  const s = await start({ env: { DEV_MAIL: '1' } })
  try {
    const owner = await s.person()
    await s.register(owner, 'owner@example.test') // open while the server has no accounts
    await s.setRegistration(false)

    // A visitor: an account, checked by an emailed code, and no vault.
    const asha = await s.person()
    await asha.goto(`${s.base}/app/`)
    await asha.getByRole('button', { name: 'Create an account' }).click()
    await asha.fill('#su-email', 'asha@example.test')
    await asha.getByRole('button', { name: 'Send me a code' }).click()
    await asha.waitForSelector('#su-code')
    await asha.fill('#su-code', '000000')
    await asha.fill('#su-pw', ACCOUNT_PASSWORD)
    await asha.fill('#su-confirm', ACCOUNT_PASSWORD)
    await asha.getByRole('button', { name: 'Create my account' }).click()
    await asha.waitForSelector('text=That code is wrong or has expired')
    await asha.fill('#su-code', await s.codeFor('asha@example.test'))
    await asha.getByRole('button', { name: 'Create my account' }).click()

    // Invitation only: no vault yet; ask for one.
    await asha.waitForSelector('#vr-note', { timeout: 60_000 })
    assert.match(await asha.textContent('.account-line'), /asha@example\.test/)
    await asha.fill('#vr-note', 'Asha from finance')
    await asha.getByRole('button', { name: 'Send a request for a vault' }).click()
    await asha.waitForSelector('text=Your request was sent')

    // The owner sees who asked, by address, and approves.
    await owner.goto(`${s.base}/app/console/server/invites`)
    await s.unlock(owner, 'owner@example.test')
    const card = owner.locator('section[aria-labelledby=vault-requests-title]')
    await card.locator('.vault-request:has-text("asha@example.test")').waitFor()
    assert.match(await card.textContent(), /Asha from finance/)
    await card.getByRole('button', { name: 'Approve asha@example.test' }).click()
    await owner.waitForSelector('text=Approved; asha@example.test was emailed', { state: 'attached' })
    const mail = (await (await fetch(`${s.base}/__dev/outbox`)).json()).find((m) => m.to === 'asha@example.test' && /ready to create/.test(m.subject))
    assert.ok(mail, 'Asha is told by email')

    // Asha comes back: the vault is hers to create.
    await asha.reload()
    await asha.waitForSelector('#cv-pw', { timeout: 60_000 })
    await asha.waitForSelector('text=Your request was approved')
    await asha.fill('#cv-pw', PASSWORD)
    await asha.fill('#cv-confirm', PASSWORD)
    await asha.getByRole('button', { name: 'Create my vault' }).click()
    await asha.waitForSelector('.recovery-key', { timeout: 60_000 })
    await asha.check('.check input')
    await asha.getByRole('button', { name: 'Open my vault' }).click()
    await asha.waitForSelector('.topbar', { timeout: 60_000 })

    // Next time: master password only (the account sign-in is kept).
    await asha.getByRole('button', { name: 'Lock vault' }).click()
    await s.unlock(asha, 'asha@example.test')

    // The console names her by address.
    await owner.goto(`${s.base}/app/console/server/users`)
    await s.unlock(owner, 'owner@example.test')
    await owner.waitForSelector('.acct-name:has-text("asha@example.test")')
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})
