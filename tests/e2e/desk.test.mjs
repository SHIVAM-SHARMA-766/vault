// Phase 3A: the service desk — a public access request approved by staff,
// sign-in help, and a support conversation between a member and staff.

import test from 'node:test'
import assert from 'node:assert/strict'

import { start } from './helpers.mjs'

test('access request → approved with an invitation; support ticket → conversation', async () => {
  const s = await start()
  try {
    // The owner exists and registration is closed, so the sign-in screen
    // offers a request for access.
    const owner = await s.person()
    await s.register(owner, 'owner@example.test')
    await s.setRegistration(false)

    // A visitor without an account asks for access from the sign-in screen.
    const visitor = await s.person()
    await visitor.goto(`${s.base}/app/`)
    await visitor.getByRole('button', { name: 'Request access' }).click()
    await visitor.fill('#pr-name', 'Riya Sen')
    await visitor.fill('#pr-email', 'riya@example.test')
    await visitor.fill('#pr-message', 'Joining the finance team')
    await visitor.getByRole('button', { name: 'Send request' }).click()
    await visitor.waitForSelector('text=Your request number is #1')

    // Locked out: asks for sign-in help.
    await visitor.getByRole('button', { name: 'Back to sign in' }).click()
    await visitor.getByRole('button', { name: /Lost your authenticator/ }).click()
    await visitor.waitForSelector('text=Nobody can reset a forgotten master password')

    // The owner sees it in the service desk and approves it.
    await s.menu(owner, 'Admin panel')
    await owner.locator('.sidebar .side-item', { hasText: 'Service desk' }).click()
    await owner.waitForSelector('td:has-text("Access request from Riya Sen")')
    await owner.locator('tr', { hasText: 'Riya Sen' }).locator('.link-strong').click()
    await owner.waitForSelector('.bubble:has-text("Joining the finance team")')
    await owner.getByRole('button', { name: 'Approve and invite' }).click()
    await owner.waitForSelector('.desk-side .recovery-key code')
    assert.match(await owner.textContent('.desk-side .recovery-key code'), /^[A-Z0-9]{4}(-[A-Z0-9]{4}){5}$/)
    assert.equal(await owner.inputValue('#d-status'), 'resolved')

    // A member asks for help; the owner answers; the member replies.
    await s.setRegistration(true)
    const member = await s.person()
    await s.register(member, 'member@example.test')
    await s.menu(member, 'Help & support')
    await member.getByRole('button', { name: 'New request' }).click()
    await member.fill('#t-subject', 'Zoho import')
    await member.selectOption('#t-category', 'problem')
    await member.fill('#t-message', 'My Zoho CSV shows no passwords')
    await member.getByRole('button', { name: 'Send', exact: true }).click()
    await member.waitForSelector('.bubble:has-text("My Zoho CSV shows no passwords")')

    await owner.getByRole('button', { name: 'Queue' }).click()
    await owner.locator('tr', { hasText: 'Zoho import' }).locator('.link-strong').click()
    await owner.fill('textarea[aria-label="Reply"]', 'Export it again with SecretData included')
    await owner.getByRole('button', { name: 'Send reply' }).click()
    await owner.waitForSelector('.bubble-staff:has-text("SecretData")')
    await owner.check('.thread-reply input[type=checkbox]')
    await owner.fill('textarea[aria-label="Reply"]', 'Probably the old export format')
    await owner.getByRole('button', { name: 'Add note' }).click()
    await owner.waitForSelector('.bubble-internal')

    await member.reload()
    await s.unlock(member, 'member@example.test')
    await s.menu(member, 'Help & support')
    await member.locator('.ticket-row', { hasText: 'Zoho import' }).click()
    await member.waitForSelector('.bubble-staff:has-text("SecretData")')
    assert.equal(await member.locator('.bubble-internal').count(), 0, 'internal notes stay with staff')
    assert.match(await member.textContent('.ticket-row'), /Waiting for you/)
    await member.fill('textarea[aria-label="Reply"]', 'That worked, thanks')
    await member.getByRole('button', { name: 'Reply' }).click()
    await member.waitForSelector('.bubble:has-text("That worked")')
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})
