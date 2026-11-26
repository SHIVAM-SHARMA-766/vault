// Hosted tenants run by the operator (admin console phase 4): a seat limit,
// a domain waiting for its DNS record, and suspend / resume.

import test from 'node:test'
import assert from 'node:assert/strict'

import { start } from './helpers.mjs'

test('the operator sets a company\'s seats, adds a domain, and suspends and resumes it', async () => {
  const s = await start({ owner: 'op@example.test', edition: 'hosted' })
  try {
    const op = await s.person()
    await s.register(op, 'op@example.test')
    await s.menu(op, 'Admin console')
    await op.locator('.console-layout .sidebar .side-item', { hasText: 'Tenants' }).click()
    await op.fill('input[aria-label="Company name"]', 'Acme Corp')
    await op.getByRole('button', { name: 'Create invitation' }).click()
    const code = (await op.locator('.company-code .recovery-key code').innerText()).trim()

    const anita = await s.person()
    await s.register(anita, 'anita@example.test', code)
    await s.menu(anita, 'Organizations')
    await anita.fill('#o-name', 'Acme Corp')
    await anita.getByRole('button', { name: 'Create', exact: true }).click()
    await anita.waitForSelector('#ork-title')
    await anita.getByLabel('I have stored it somewhere safe').check()
    await anita.getByRole('button', { name: 'Done' }).click()

    await op.reload(); await s.unlock(op, 'op@example.test')
    await op.getByRole('button', { name: 'Manage Acme Corp' }).click()
    await op.waitForSelector('.drawer #tenant-seats')
    await op.fill('#tenant-seats', '5')
    await op.locator('.drawer').getByRole('button', { name: 'Save' }).click()
    await op.waitForSelector('text=Seat limit set to 5', { state: 'attached' })
    await op.waitForSelector('.drawer .pill:has-text("1 of 5 seats")')

    await op.fill('input[aria-label="Domain"]', 'acme.example')
    await op.getByRole('button', { name: 'Add domain' }).click()
    await op.waitForSelector('.drawer .pill:has-text("Waiting for DNS")')
    assert.match(await op.locator('.dns-record code').innerText(), /_vault-verify\.acme\.example\s+TXT\s+"vault-verify=[0-9a-f]{32}"/)

    op.once('dialog', (d) => d.accept())
    await op.getByRole('button', { name: 'Suspend company' }).click()
    await op.waitForSelector('text=Company suspended', { state: 'attached' })
    await op.keyboard.press('Escape')
    await op.waitForSelector('tr:has-text("Acme Corp") .pill:has-text("Suspended")')
    assert.match(await op.locator('tr:has-text("Acme Corp")').innerText(), /1 \/ 5/)

    // The company's admin keeps their own vault and is told why the company is shut.
    await anita.reload(); await s.unlock(anita, 'anita@example.test')
    await s.menu(anita, 'Organizations')
    await anita.waitForSelector('.org-card .pill:has-text("Suspended")', { timeout: 30_000 })
    await anita.waitForSelector('text=suspended by the people who run this server')

    await op.getByRole('button', { name: 'Manage Acme Corp' }).click()
    await op.getByRole('button', { name: 'Resume company' }).click()
    await op.waitForSelector('text=Company resumed', { state: 'attached' })
    assert.deepEqual(s.errors.filter((e) => !/suspended/.test(e)), [])
  } finally {
    await s.stop()
  }
})
