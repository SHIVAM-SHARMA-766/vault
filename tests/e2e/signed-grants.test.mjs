// Signed key grants (decisions/0025), against a server that misbehaves:
// Playwright rewrites the server's answer on the way to Bob's browser. A
// grant whose key blob was swapped fails its signature and is refused; once
// Bob has seen his grants fully signed, a grant stripped of its signature is
// refused too.

import test from 'node:test'
import assert from 'node:assert/strict'

import { start } from './helpers.mjs'

test('a swapped or unsigned grant is refused after signing; honest grants open', async () => {
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
    await alice.waitForSelector('#ork-title')
    await alice.getByLabel('I have stored it somewhere safe').check()
    await alice.getByRole('button', { name: 'Done' }).click()
    // Managed from the admin console (decisions/0031).
    await s.manage(alice, 'Acme', 'Collections')
    await alice.fill('input[aria-label="New collection name"]', 'Finance')
    await alice.getByRole('button', { name: 'Add collection' }).click()
    await alice.waitForSelector('.collection-row:has-text("Finance")')
    await s.manage(alice, 'Acme', 'Members')
    await alice.fill('input[aria-label="Email to invite"]', 'bob@example.test')
    await alice.fill('input[aria-label="Name for this member"]', 'Bob')
    await alice.getByRole('button', { name: 'Invite', exact: true }).click()
    await s.menu(bob, 'Organizations')
    await bob.getByRole('button', { name: 'Accept' }).click()
    await bob.waitForSelector('text=An admin must confirm you')

    await alice.reload(); await s.unlock(alice, 'alice@example.test')
    await s.manage(alice, 'Acme', 'Members')
    await alice.locator('.device-row', { hasText: 'Bob' }).getByRole('button', { name: 'Confirm…' }).click()
    // The fingerprint Alice compares is the same one Bob sees: both keys.
    const shownToAlice = (await alice.textContent('.confirm .fingerprint code')).trim()
    await s.menu(bob, 'Organizations')
    const bobsOwn = (await bob.textContent('.fingerprint code')).trim()
    assert.equal(shownToAlice, bobsOwn)
    await alice.getByRole('button', { name: 'It matches — confirm' }).click()
    await alice.waitForSelector('text=Bob confirmed', { state: 'attached' })
    await s.manage(alice, 'Acme', 'Collections')
    await alice.locator('.collection-row', { hasText: 'Finance' }).getByRole('button', { name: 'Access' }).click()
    await alice.selectOption('select[aria-label="Member"]', { label: 'Bob' })
    await alice.getByRole('button', { name: 'Share', exact: true }).click()
    await alice.waitForSelector('.access-list li:has-text("Bob")')

    // Honest server: Bob opens Finance, signed by the owner he pinned.
    await bob.reload(); await s.unlock(bob, 'bob@example.test')
    await s.menu(bob, 'Vault')
    await bob.getByRole('button', { name: /Finance/ }).waitFor()

    // A server that swaps the sealed key in Bob's grant: the signature no longer matches.
    await bob.route('**/api/orgs/*/collections', async (route) => {
      const res = await route.fetch()
      const body = await res.json()
      for (const c of body.collections) if (c.access) c.access.keyBlob = c.access.keyBlob.replace(/.$/, (ch) => (ch === 'A' ? 'B' : 'A'))
      await route.fulfill({ response: res, json: body })
    })
    await bob.reload(); await s.unlock(bob, 'bob@example.test')
    await s.menu(bob, 'Organizations')
    await bob.waitForSelector('.collection-row:has-text("Finance") >> text=Key not trusted')
    await s.menu(bob, 'Vault')
    await bob.waitForSelector('.sidebar')
    assert.equal(await bob.getByRole('button', { name: /Finance/ }).count(), 0, 'the swapped key is not used')

    // A server that strips the signature, after Bob has seen everything signed.
    await bob.unroute('**/api/orgs/*/collections')
    await bob.route('**/api/orgs/*/collections', async (route) => {
      const res = await route.fetch()
      const body = await res.json()
      // Before the account is unlocked again the server answers with an error,
      // which has no collections: pass it on as it is.
      if (!Array.isArray(body.collections)) return route.fulfill({ response: res })
      for (const c of body.collections) if (c.access) { delete c.access.signature; delete c.access.signedBy }
      await route.fulfill({ response: res, json: body })
    })
    await bob.reload(); await s.unlock(bob, 'bob@example.test')
    await s.menu(bob, 'Organizations')
    await bob.waitForSelector('.collection-row:has-text("Finance") >> text=Key not trusted')
  } finally {
    await s.stop()
  }
})
