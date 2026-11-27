// Several vaults: each key wrapped under the account key and bound to its id;
// the keyring picks the right key; foreign or moved vaults do not open.

import test from 'node:test'
import assert from 'node:assert/strict'

import { Keyring, createVault, generateVaultKey, openEntry, openVaults, sealEntry, sealVault } from '../src/index.js'

test('a new vault opens with the account key, and its own key seals its entries', async () => {
  const account = generateVaultKey()
  const { vault, sealed } = await createVault('work-1', { name: 'Work', icon: 'briefcase' }, account)
  assert.notDeepEqual(vault.key, account)
  const [opened] = await openVaults([sealed], account)
  assert.equal(opened!.name, 'Work')
  assert.equal(opened!.icon, 'briefcase')
  assert.deepEqual(opened!.key, vault.key)

  const ring = new Keyring(account, [opened!])
  assert.deepEqual(ring.keyFor(undefined), account, 'Personal is the account key')
  assert.deepEqual(ring.keyFor('work-1'), vault.key)
  assert.equal(ring.keyFor('nope'), null)

  const blob = await sealEntry('e1', { name: 'Jira', type: 'login', tags: [], customFields: [], favorite: false }, ring.keyFor('work-1')!)
  assert.equal((await openEntry('e1', blob, vault.key)).name, 'Jira')
  await assert.rejects(openEntry('e1', blob, account), 'the account key alone does not open a vault entry')
})

test('renaming keeps the key; a vault from another account or under another id is skipped', async () => {
  const account = generateVaultKey()
  const { vault, sealed } = await createVault('fam', { name: 'Family' }, account)
  const renamed = await sealVault({ ...vault, name: 'Home' }, account)
  const [again] = await openVaults([renamed], account)
  assert.equal(again!.name, 'Home')
  assert.deepEqual(again!.key, vault.key)

  assert.deepEqual(await openVaults([sealed], generateVaultKey()), [], 'another account cannot open it')
  assert.deepEqual(await openVaults([{ ...sealed, id: 'other' }], account), [], 'the key is bound to the vault id')
})
