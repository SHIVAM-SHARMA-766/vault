// Attachments (D2), the offline copy (C4) and member onboarding (B4).

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PASSWORD, start } from './helpers.mjs'

test('attach a file, download it decrypted, remove it; deleting the item deletes the file', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await s.register(page, 'dev@example.test')
    await page.click('.topbar .btn-primary')
    await page.fill('#f-name', 'Insurance')
    await page.setInputFiles('input[aria-label="Attach a file"]', { name: 'policy.txt', mimeType: 'text/plain', buffer: Buffer.from('Policy number 12345') })
    await page.waitForSelector('.attachment-list li:has-text("policy.txt")')
    await page.click('.editor-foot .btn-primary')
    await page.waitForSelector('.detail h2:has-text("Insurance")')

    const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download policy.txt' }).click()])
    assert.equal(file.suggestedFilename(), 'policy.txt')
    const text = await (await file.createReadStream()).toArray().then((c) => Buffer.concat(c).toString('utf8'))
    assert.equal(text, 'Policy number 12345', 'decrypted in the browser')

    // A file over 2 MB is refused before upload.
    await page.locator('.detail-actions').getByRole('button', { name: 'Edit' }).click()
    await page.setInputFiles('input[aria-label="Attach a file"]', { name: 'big.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(2 * 1024 * 1024 + 1) })
    await page.waitForSelector('text=big.bin is larger than 2 MB')
    await page.getByRole('button', { name: 'Remove policy.txt' }).click()
    await page.click('.editor-foot .btn-primary')
    await page.waitForSelector('.detail h2:has-text("Insurance")')
    assert.equal(await page.getByRole('button', { name: 'Download policy.txt' }).count(), 0)
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})

test('the offline copy opens from disk with the master password, with no server', async () => {
  const s = await start()
  try {
    const page = await s.person()
    await s.register(page, 'dev@example.test')
    await page.click('.topbar .btn-primary')
    await page.fill('#f-name', 'Router admin')
    await page.fill('#f-username', 'admin')
    await page.fill('#f-password', 'r0uter-Pass-Long-Enough')
    await page.click('.editor-foot .btn-primary')
    await page.waitForSelector('.detail h2:has-text("Router admin")')
    await s.settings(page, 'Backups')
    const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download an offline copy' }).click()])
    assert.match(file.suggestedFilename(), /^vault-offline-\d{4}-\d{2}-\d{2}\.html$/)
    const html = await (await file.createReadStream()).toArray().then((c) => Buffer.concat(c).toString('utf8'))
    assert.ok(!html.includes('r0uter-Pass'), 'encrypted')

    const dir = mkdtempSync(join(tmpdir(), 'vault-offline-'))
    const path = join(dir, 'copy.html')
    writeFileSync(path, html)
    const off = await s.person()
    const requests = []
    off.on('request', (r) => { if (!r.url().startsWith('file:')) requests.push(r.url()) })
    await off.goto(`file://${path}`)
    await off.fill('#pw', 'not the password at all')
    await off.click('#go')
    await off.waitForSelector('text=does not open this copy')
    await off.fill('#pw', PASSWORD)
    await off.click('#go')
    await off.waitForSelector('#list button:has-text("Router admin")')
    await off.click('#list button:has-text("Router admin")')
    assert.match(await off.textContent('#detail'), /admin/)
    await off.locator('#detail button', { hasText: 'Show' }).first().click()
    assert.match(await off.textContent('#detail'), /r0uter-Pass-Long-Enough/)
    assert.deepEqual(requests, [], 'no network at all')
  } finally {
    await s.stop()
  }
})

test('joining an organization: told what to do while waiting, welcomed once confirmed', async () => {
  const s = await start({ owner: 'alice@example.test' })
  try {
    const alice = await s.person()
    await s.register(alice, 'alice@example.test')
    await s.setRegistration(true)
    const bob = await s.person()
    await s.register(bob, 'bob@example.test')
    await s.menu(alice, 'Organizations')
    await alice.fill('#o-name', 'Acme')
    await alice.getByRole('button', { name: 'Create', exact: true }).click()
    await alice.waitForSelector('.org-card h2:has-text("Acme")')
    await alice.fill('input[aria-label="Email to invite"]', 'bob@example.test')
    await alice.getByRole('button', { name: 'Invite', exact: true }).click()
    await alice.waitForSelector('text=has not joined yet')

    await s.menu(bob, 'Organizations')
    await bob.getByRole('button', { name: 'Accept' }).click()
    await bob.waitForSelector('text=An admin must confirm you')
    await s.menu(bob, 'Vault')
    await bob.waitForSelector('.onboarding:has-text("You have joined Acme")')
    assert.ok(await bob.locator('.onboarding-fp').count())

    await alice.reload(); await s.unlock(alice, 'alice@example.test')
    await s.menu(alice, 'Organizations')
    await alice.locator('.device-row', { hasText: 'bob' }).getByRole('button', { name: 'Confirm…' }).click()
    await alice.getByRole('button', { name: 'It matches — confirm' }).click()
    await alice.waitForSelector('text=confirmed', { state: 'attached' })

    await bob.reload(); await s.unlock(bob, 'bob@example.test')
    await bob.waitForSelector('.onboarding:has-text("You are in Acme")')
    await bob.getByRole('button', { name: 'Got it' }).click()
    await bob.waitForSelector('.onboarding', { state: 'detached' })
    await bob.reload(); await s.unlock(bob, 'bob@example.test')
    await bob.waitForSelector('.sidebar')
    assert.equal(await bob.locator('.onboarding').count(), 0, 'once')
  } finally {
    await s.stop()
  }
})
