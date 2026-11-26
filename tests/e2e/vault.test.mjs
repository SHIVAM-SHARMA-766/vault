// The vault itself: sign up, store an entry, lock, unlock, and find it again —
// through a real browser, against the real API, under the production policy.

import test from 'node:test'
import assert from 'node:assert/strict'

import { start } from './helpers.mjs'

test('sign up, add an entry, lock, unlock, and it is still there', async () => {
  const s = await start()
  try {
    const page = await s.person()
    const sentIdentity = page.waitForRequest((r) => r.url().endsWith('/api/auth/register'))
    await s.register(page, 'alice@example.test')
    // Every new account is created with an identity key pair (decisions/0009).
    const body = JSON.parse((await sentIdentity).postData() ?? '{}')
    assert.ok(body.identity?.publicKey, 'registration carries a public key')
    assert.match(body.identity?.wrappedPrivateKey ?? '', /^v1\./, 'and a sealed private key')
    assert.ok(!('password' in body))

    await page.click('.topbar .btn-primary')
    await page.fill('#f-name', 'GitHub')
    await page.fill('#f-username', 'alice')
    await page.fill('#f-password', 'correct horse battery staple')
    await page.click('.editor-foot .btn-primary')
    await page.waitForSelector('.detail-head')

    await page.getByRole('button', { name: 'Lock vault' }).click()
    await page.waitForSelector('#password')
    await s.unlock(page, 'alice@example.test')
    await page.waitForSelector('.row-item')
    assert.match(await page.textContent('.rows'), /GitHub/)
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})

test('a wrong master password is refused without saying which part was wrong', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await s.register(page, 'bob@example.test')
    await page.getByRole('button', { name: 'Lock vault' }).click()
    await page.fill('#password', 'not the passphrase at all')
    await page.click('button[type=submit]')
    await page.waitForSelector('.alert-error', { timeout: 60_000 })
    assert.equal(await page.textContent('.alert-error'), 'That master password is not right.')
  } finally {
    await s.stop()
  }
})
