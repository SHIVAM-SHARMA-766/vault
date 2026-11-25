// The hosted edition (decisions/0033): the operator invites a company; its
// admin signs up with the code and creates it; a personal account cannot.

import test from 'node:test'
import assert from 'node:assert/strict'

import { start } from './helpers.mjs'

test('hosted: the operator invites a company, its admin creates it, a personal user cannot', async () => {
  const s = await start({ owner: 'operator@example.test', edition: 'hosted' })
  try {
    const op = await s.person()
    await s.register(op, 'operator@example.test')

    // The operator's console: Tenants, with Invite a company.
    await s.menu(op, 'Admin console')
    await op.locator('.sidebar .side-item', { hasText: 'Tenants' }).click()
    await op.fill('input[aria-label="Company name"]', 'Acme Corp')
    await op.getByRole('button', { name: 'Create invitation' }).click()
    const code = (await op.locator('.company-code .recovery-key code').innerText()).trim()

    // Its admin signs up with the code and creates the company.
    const anita = await s.person()
    await s.register(anita, 'anita@acme.example', code)
    await s.menu(anita, 'Organizations')
    await anita.waitForSelector('#o-new')
    await anita.fill('#o-name', 'Acme Corp')
    await anita.getByRole('button', { name: 'Create', exact: true }).click()
    await anita.waitForSelector('#ork-title')
    await anita.getByLabel('I have stored it somewhere safe').check()
    await anita.getByRole('button', { name: 'Done' }).click()
    await anita.waitForSelector('.console-org h1:has-text("People")')
    assert.equal(await anita.locator('.workspace-switch').count(), 1, 'Anita runs her company from the console')

    // A personal user: no way to create one, told why.
    const priya = await s.person()
    await s.register(priya, 'priya@personal.example')
    await s.menu(priya, 'Organizations')
    await priya.waitForSelector('#o-invited')
    assert.equal(await priya.locator('#o-new').count(), 0)

    // The tenant shows in the operator's list.
    await s.menu(op, 'Admin console')
    await op.locator('.sidebar .side-item', { hasText: 'Tenants' }).click()
    await op.locator('table.data tr', { hasText: 'Acme Corp' }).waitFor()
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})
