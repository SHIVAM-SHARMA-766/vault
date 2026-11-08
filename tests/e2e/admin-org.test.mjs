// For an organization running its own server: the setup checklist and
// inviting many people at once.

import test from 'node:test'
import assert from 'node:assert/strict'

import { start } from './helpers.mjs'

test('the setup checklist reflects the server, and ticks items as they are done', async () => {
  const s = await start()
  try {
    const owner = await s.person()
    await s.register(owner, 'owner@example.test')
    await s.menu(owner, 'Admin panel')
    await owner.waitForSelector('#setup-title')
    const left = async () => Number(/(\d+) of 6 left/.exec(await owner.textContent('.admin-checklist'))?.[1])
    const before = await left()
    assert.ok(before >= 4, `${before} left on a fresh server`)
    await owner.fill('#pf-email', 'help@example.test')
    await owner.locator('form[aria-labelledby=profile-title]').getByRole('button', { name: 'Save' }).click()
    await owner.waitForSelector('text=Name, support contact and branding saved')
    await owner.reload(); await s.unlock(owner, 'owner@example.test')
    await owner.waitForSelector('#setup-title')
    assert.equal(await left(), before - 1)
  } finally {
    await s.stop()
  }
})

test('invite many: paste a list, get codes back without mail, and a closed server warns', async () => {
  const s = await start()
  try {
    const owner = await s.person()
    await s.register(owner, 'owner@example.test')
    await s.setRegistration(false)
    await s.menu(owner, 'Admin panel')
    await owner.locator('.sidebar .side-item', { hasText: 'Invitations' }).click()
    await owner.getByRole('button', { name: 'Invite many people at once…' }).click()
    await owner.fill('#bulk-people', 'email,name\nasha@example.test, Asha (finance)\nnot-an-address\n')
    await owner.waitForSelector('text=1 line to fix')
    assert.equal(await owner.getByRole('button', { name: /^Invite/ }).last().isDisabled(), true)
    await owner.fill('#bulk-people', 'asha@example.test, Asha (finance)\nravi@example.test\tRavi')
    await owner.waitForSelector('text=2 people')
    await owner.getByRole('button', { name: 'Invite 2' }).click()
    await owner.waitForSelector('.bulk-codes li >> nth=1')
    assert.match(await owner.textContent('.bulk-invite'), /0 of 2 emailed/)
    assert.match(await owner.textContent('.bulk-invite'), /Registration is closed/)
    const code = (await owner.locator('.bulk-codes code').first().textContent()).trim()

    // Open to invitations; the code works.
    await owner.locator('.sidebar .side-item', { hasText: 'Overview' }).click()
    await owner.getByRole('radio', { name: 'Invite only' }).click()
    await owner.waitForSelector('text=Registration is now invite')
    const asha = await s.person()
    await s.register(asha, 'asha@example.test', code)
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})
