// Argon2id (decisions/0028): a new account derives with it in the browser
// (WebAssembly under the served policy), and an account from before upgrades
// from Settings, keeping its password and every item.

import test from 'node:test'
import assert from 'node:assert/strict'

import { createAccount } from '../../packages/crypto/dist/src/index.js'
import { PASSWORD, start } from './helpers.mjs'

test('a new account uses Argon2id; a PBKDF2 account upgrades and keeps its items', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await s.register(page, 'new@example.test')
    const kdf = await page.evaluate(async () => (await fetch('/api/auth/prelogin', { method: 'POST', headers: { 'content-type': 'application/json', 'x-vault-auth': '1' }, body: JSON.stringify({ email: 'new@example.test' }) })).json())
    assert.equal(kdf.kdf.algorithm, 'argon2id')
    await s.settings(page, 'Security')
    assert.equal(await page.locator('section[aria-labelledby=s-kdf]').count(), 0, 'nothing to upgrade')

    // An account as Vault made them before 0028: PBKDF2, 600,000 iterations.
    const old = await createAccount(PASSWORD, 600_000)
    const reg = await fetch(`${s.base}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-vault-auth': '1', 'x-forwarded-for': '10.9.9.9' },
      body: JSON.stringify({ email: 'old@example.test', authKey: old.authKey, recoveryAuthKey: old.recoveryAuthKey, kdf: old.kdf, wrappedVaultKey: old.wrappedVaultKey, wrappedVaultKeyForRecovery: old.wrappedVaultKeyForRecovery }),
    })
    assert.equal(reg.status, 201, await reg.clone().text())

    const p2 = await s.person()
    await p2.goto(`${s.base}/app/`)
    await s.unlock(p2, 'old@example.test')
    await p2.click('.topbar .btn-primary')
    await p2.fill('#f-name', 'Bank')
    await p2.fill('#f-password', 'a-long-strong-and-unique-password-1')
    await p2.click('.editor-foot .btn-primary')
    await p2.waitForSelector('.detail h2:has-text("Bank")')

    await s.settings(p2, 'Security')
    const card = p2.locator('section[aria-labelledby=s-kdf]')
    await card.getByRole('button', { name: 'Upgrade to Argon2id' }).click()
    await p2.fill('#kdf-pw', PASSWORD)
    await card.getByRole('button', { name: 'Upgrade', exact: true }).click()
    await p2.waitForSelector('text=Key derivation upgraded to Argon2id', { state: 'attached' })
    await card.waitFor({ state: 'detached' })

    // Same password, new derivation, the item still opens.
    await p2.getByRole('button', { name: 'Lock vault' }).click()
    await s.unlock(p2, 'old@example.test')
    await p2.click('.topbar .brand')
    await p2.locator('.row-item', { hasText: 'Bank' }).click()
    await p2.waitForSelector('.detail h2:has-text("Bank")')
    const after = await p2.evaluate(async () => (await fetch('/api/auth/prelogin', { method: 'POST', headers: { 'content-type': 'application/json', 'x-vault-auth': '1' }, body: JSON.stringify({ email: 'old@example.test' }) })).json())
    assert.equal(after.kdf.algorithm, 'argon2id')
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})
