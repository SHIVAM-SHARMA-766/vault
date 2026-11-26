// Single sign-on (decisions/0021) in a real browser, against a mock OpenID
// Connect provider: sign in through it, then the master password; require it
// from the console, with the owner's way in kept; provision a newcomer.

import test from 'node:test'
import assert from 'node:assert/strict'

import { mockIdp } from './mock-idp.mjs'
import { ACCOUNT_PASSWORD, PASSWORD, start } from './helpers.mjs'

test('sign in with the provider, then the master password; "require SSO" folds the password away', async () => {
  const idp = await mockIdp()
  const s = await start({ env: idp.env() })
  try {
    const owner = await s.person()
    await s.register(owner, 'owner@example.test')
    await s.setRegistration(true)
    const person = await s.person()
    await s.register(person, 'person@example.test')
    // The account step is where the provider comes in (decisions/0036): sign
    // this device out of the account to see it.
    await s.menu(person, 'Sign out of this device')

    // Through the provider and back: the account is signed in, the master password still asked.
    idp.email = 'person@example.test'
    await person.getByRole('link', { name: 'Sign in with Okta' }).click()
    await person.waitForSelector('.account-line', { timeout: 60_000 })
    assert.equal(new URL(person.url()).hash, '', 'the ticket is gone from the address bar')
    assert.equal((await person.textContent('.account-line strong'))?.trim(), 'person@example.test')
    await person.fill('#password', PASSWORD)
    await person.click('button[type=submit]')
    await person.waitForSelector('.topbar', { timeout: 60_000 })

    // The owner requires it.
    await s.menu(owner, 'Admin panel')
    await owner.waitForSelector('#policy-title')
    await owner.getByLabel(/Require single sign-on with Okta/).check()
    await owner.locator('form[aria-labelledby=policy-title]').getByRole('button', { name: 'Save' }).click()
    await owner.waitForSelector('text=Policies saved', { state: 'attached' })

    // Now the account step offers only the provider; the account password alone is refused.
    await s.menu(person, 'Sign out of this device')
    await person.reload()
    await person.getByRole('link', { name: 'Sign in with Okta' }).waitFor()
    assert.equal(await person.locator('#account-password').count(), 0)
    await person.getByRole('button', { name: /Server owner\? Sign in with your account password/ }).click()
    await person.fill('#email', 'person@example.test')
    await person.fill('#account-password', ACCOUNT_PASSWORD)
    await person.click('button[type=submit]')
    await person.waitForSelector('text=This server requires signing in with Okta first.')
    // Through the provider it works.
    await person.reload()
    await person.getByRole('link', { name: 'Sign in with Okta' }).click()
    await person.waitForSelector('.account-line', { timeout: 60_000 })
    await person.fill('#password', PASSWORD)
    await person.click('button[type=submit]')
    await person.waitForSelector('.topbar', { timeout: 60_000 })

    // The owner is exempt.
    await s.menu(owner, 'Sign out of this device')
    await owner.reload()
    await owner.getByRole('button', { name: /Server owner\?/ }).click()
    await s.unlock(owner, 'owner@example.test')
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
    await idp.close()
  }
})

test('with provisioning, a newcomer the provider signs in creates an account for that address', async () => {
  const idp = await mockIdp()
  const s = await start({ env: idp.env({ OIDC_PROVISION: 'true' }) })
  try {
    const owner = await s.person()
    await s.register(owner, 'owner@example.test')   // registration is invite-only from here
    const newcomer = await s.person()
    idp.email = 'newcomer@example.test'
    await newcomer.goto(`${s.base}/app/`)
    await newcomer.getByRole('link', { name: 'Sign in with Okta' }).click()
    await newcomer.waitForSelector('text=Your identity provider signed you in as')
    assert.equal(await newcomer.inputValue('#r-email'), 'newcomer@example.test')
    assert.equal(await newcomer.locator('#r-invite').count(), 0, 'no invitation needed')
    await newcomer.fill('#r-account', ACCOUNT_PASSWORD)
    await newcomer.fill('#r-account-confirm', ACCOUNT_PASSWORD)
    await newcomer.fill('#r-password', PASSWORD)
    await newcomer.fill('#r-confirm', PASSWORD)
    await newcomer.click('button[type=submit]')
    await newcomer.waitForSelector('.recovery-key', { timeout: 60_000 })
  } finally {
    await s.stop()
    await idp.close()
  }
})
