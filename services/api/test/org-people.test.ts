// People in organizations: passwords to change after someone leaves (B9),
// one-step offboarding, groups chosen at invite time and invitations sent
// again (B2), and branding (B3).

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  fromBase64Url, generateCollectionKey, generateIdentityKeyPair, generateOrgKey, sealCollectionKey, sealOrgKey, sealOrgMeta, sealCollectionMeta, toBase64Url,
} from '@vault/crypto'

import { fixtureB64, harness, registration, sealedBlob } from './harness.js'

type H = ReturnType<typeof harness>
const uuid = () => crypto.randomUUID()

async function person(h: H, email: string) {
  const keys = await generateIdentityKeyPair()
  const res = await h.request('POST', '/api/auth/register', {
    body: registration({ email, authKey: fixtureB64(email), identity: { publicKey: toBase64Url(keys.publicKey), wrappedPrivateKey: sealedBlob(`${email}-pk`, 160) } }),
  })
  assert.equal(res.status, 201)
  return { email, keys, token: String(res.body['accessToken']), userId: String(res.body['userId']) }
}

async function people() {
  const h = harness({ adminEmails: ['owner@example.com'], allowRegistration: true, mail: true })
  const owner = await person(h, 'owner@example.com')
  const ana = await person(h, 'ana@example.com')
  const ben = await person(h, 'ben@example.com')
  return { h, owner, ana, ben }
}

async function newOrg(h: H, who: Awaited<ReturnType<typeof person>>, hint = 'Acme') {
  const orgId = uuid()
  const orgKey = generateOrgKey()
  assert.equal((await h.request('POST', '/api/orgs', { token: who.token, body: {
    id: orgId, hint, label: 'Owner', nameBlob: await sealOrgMeta(orgId, { name: hint }, orgKey), orgKeyBlob: await sealOrgKey(who.keys.publicKey, orgKey, orgId),
  } })).status, 201)
  const collId = uuid()
  const collKey = generateCollectionKey()
  assert.equal((await h.request('POST', `/api/orgs/${orgId}/collections`, { token: who.token, body: {
    id: collId, nameBlob: await sealCollectionMeta(orgId, collId, { name: 'Ops' }, orgKey), keyBlob: await sealCollectionKey(who.keys.publicKey, collKey, collId, 1),
  } })).status, 201)
  return { orgId, orgKey, collId, collKey }
}

async function join(h: H, admin: Awaited<ReturnType<typeof person>>, who: Awaited<ReturnType<typeof person>>, org: Awaited<ReturnType<typeof newOrg>>, label: string, groups?: string[]) {
  assert.equal((await h.request('POST', `/api/orgs/${org.orgId}/invites`, { token: admin.token, body: { email: who.email, label, ...(groups ? { groups } : {}) } })).status, 201)
  assert.equal((await h.request('POST', `/api/orgs/${org.orgId}/accept`, { token: who.token })).status, 200)
  assert.equal((await h.request('POST', `/api/orgs/${org.orgId}/members/${who.userId}/confirm`, { token: admin.token, body: { orgKeyBlob: await sealOrgKey(who.keys.publicKey, org.orgKey, org.orgId) } })).status, 200)
}

/** An organization owned by `owner`, with ana as a confirmed member holding
 *  edit access to a collection of two items. */
async function orgWithItems() {
  const p = await people()
  const { h, owner, ana } = p
  const org = await newOrg(h, owner)
  await join(h, owner, ana, org, 'Ana')
  assert.equal((await h.request('PUT', `/api/orgs/${org.orgId}/collections/${org.collId}/access/${ana.userId}`, { token: owner.token, body: {
    permission: 'edit', keyBlob: await sealCollectionKey(fromBase64Url(toBase64Url(ana.keys.publicKey)), org.collKey, org.collId, 1),
  } })).status, 200)
  const items = [uuid(), uuid()]
  for (const id of items) assert.equal((await h.request('PUT', `/api/orgs/${org.orgId}/collections/${org.collId}/items/${id}`, { token: owner.token, body: { blob: sealedBlob(id), keyVersion: 1 } })).status, 200)
  return { ...p, ...org, anaId: ana.userId, items }
}

test('removing a member lists every password they could see, until each is changed', async () => {
  const { h, owner: o, orgId, collId, anaId, items } = await orgWithItems()
  const owner = o.token
  const res = await h.request('DELETE', `/api/orgs/${orgId}/members/${anaId}`, { token: owner })
  assert.equal(res.status, 200)
  assert.equal(res.body['passwordsToChange'], 2)
  let stale = (await h.request('GET', `/api/orgs/${orgId}/stale`, { token: owner })).body['items'] as { itemId: string; who: string }[]
  assert.deepEqual(stale.map((s) => s.itemId).sort(), [...items].sort())
  assert.equal(stale[0]!.who, 'Ana')
  // An edit that does not change the password leaves the mark; one that does clears it.
  await h.request('PUT', `/api/orgs/${orgId}/collections/${collId}/items/${items[0]}`, { token: owner, body: { blob: sealedBlob('i1b'), keyVersion: 1 } })
  assert.equal(((await h.request('GET', `/api/orgs/${orgId}/stale`, { token: owner })).body['items'] as unknown[]).length, 2)
  await h.request('PUT', `/api/orgs/${orgId}/collections/${collId}/items/${items[0]}`, { token: owner, body: { blob: sealedBlob('i1c'), keyVersion: 1, passwordChanged: true } })
  await h.request('DELETE', `/api/orgs/${orgId}/collections/${collId}/items/${items[1]}`, { token: owner })
  stale = (await h.request('GET', `/api/orgs/${orgId}/stale`, { token: owner })).body['items'] as typeof stale
  assert.deepEqual(stale, [])
})

test('offboarding disables, signs out, and takes the account out of every organization', async () => {
  const { h, owner: o, ana: a, orgId, anaId } = await orgWithItems()
  const owner = o.token, ana = a.token
  const res = await h.request('POST', `/api/admin/users/${anaId}/offboard`, { token: owner })
  assert.equal(res.status, 200)
  assert.equal((await h.request('GET', '/api/vault', { token: ana })).status, 401, 'signed out at once')
  assert.equal((await h.request('POST', '/api/auth/login', { body: { email: 'ana@example.com', authKey: fixtureB64('ana@example.com') } })).status, 403, 'disabled')
  const members = (await h.request('GET', `/api/orgs/${orgId}/members`, { token: owner })).body['members'] as { userId: string }[]
  assert.ok(!members.some((m) => m.userId === anaId))
  assert.equal(((await h.request('GET', `/api/orgs/${orgId}/stale`, { token: owner })).body['items'] as unknown[]).length, 2)
  const audit = (await h.request('GET', '/api/admin/audit', { token: owner })).body['records'] as { action: string }[]
  assert.ok(audit.some((r) => r.action === 'user.offboard'))
})

test('an account that owns an organization cannot be offboarded until it is handed over', async () => {
  const { h, owner, ana } = await people()
  await newOrg(h, ana, 'Ana Co')
  const res = await h.request('POST', `/api/admin/users/${ana.userId}/offboard`, { token: owner.token })
  assert.equal(res.status, 409)
  assert.match(String(res.body['message']), /Ana Co/)
})

test('groups chosen at invite time wait on the member until the admin adds them', async () => {
  const { h, owner, ben } = await people()
  const org = await newOrg(h, owner)
  const grp = uuid()
  assert.equal((await h.request('POST', `/api/orgs/${org.orgId}/groups`, { token: owner.token, body: { id: grp, nameBlob: sealedBlob('g') } })).status, 201)
  assert.equal((await h.request('POST', `/api/orgs/${org.orgId}/invites`, { token: owner.token, body: { email: ben.email, groups: ['nope'] } })).status, 400)
  assert.equal((await h.request('POST', `/api/orgs/${org.orgId}/invites`, { token: owner.token, body: { email: ben.email, groups: [grp] } })).status, 201)
  const pending = (await h.request('GET', `/api/orgs/${org.orgId}/members`, { token: owner.token })).body['pending'] as { groups: string[] }[]
  assert.deepEqual(pending[0]!.groups, [grp])
  await h.request('POST', `/api/orgs/${org.orgId}/accept`, { token: ben.token })
  await h.request('POST', `/api/orgs/${org.orgId}/members/${ben.userId}/confirm`, { token: owner.token, body: { orgKeyBlob: await sealOrgKey(ben.keys.publicKey, org.orgKey, org.orgId) } })
  const benId = ben.userId
  let m = ((await h.request('GET', `/api/orgs/${org.orgId}/members`, { token: owner.token })).body['members'] as { userId: string; pendingGroups: string[] }[]).find((x) => x.userId === benId)!
  assert.deepEqual(m.pendingGroups, [grp])
  assert.equal((await h.request('PUT', `/api/orgs/${org.orgId}/groups/${grp}/members/${benId}`, { token: owner.token })).status, 200)
  m = ((await h.request('GET', `/api/orgs/${org.orgId}/members`, { token: owner.token })).body['members'] as typeof m[]).find((x) => x.userId === benId)!
  assert.deepEqual(m.pendingGroups, [], 'joining clears it')
})

test('an unused invitation is sent again with a fresh code; the old code stops working', async () => {
  const { h, owner: o } = await people()
  const owner = o.token
  h.app.allowRegistration = false
  await h.request('PUT', '/api/admin/settings', { token: owner, body: { registration: 'invite' } })
  const first = (await h.request('POST', '/api/admin/invites', { token: owner, body: { label: 'Cara', days: 7 } })).body
  const oldId = (first['invite'] as { id: string }).id
  const again = await h.request('POST', `/api/admin/invites/${oldId}/resend`, { token: owner, body: { email: 'cara@example.com' } })
  assert.equal(again.status, 201)
  assert.equal(again.body['emailed'], true)
  assert.notEqual(again.body['code'], first['code'])
  assert.match(h.outbox.at(-1)!.text, new RegExp(String(again.body['code'])))
  const ids = ((await h.request('GET', '/api/admin/invites', { token: owner })).body['invites'] as { id: string }[]).map((i) => i.id)
  assert.ok(!ids.includes(oldId))
  const used = await h.request('POST', '/api/auth/register', { body: registration({ email: 'cara@example.com', authKey: fixtureB64('cara'), inviteCode: first['code'] }) })
  assert.notEqual(used.status, 201, 'the old code is dead')
  assert.equal((await h.request('POST', `/api/admin/invites/${oldId}/resend`, { token: owner, body: {} })).status, 404)
})

test('branding: an accent from the list and a small image logo, public on the instance', async () => {
  const { h, owner: o } = await people()
  const owner = o.token
  const png = `data:image/png;base64,${Buffer.from('fake-png-bytes').toString('base64')}`
  const base = { name: 'Acme', supportEmail: '', supportUrl: '' }
  assert.equal((await h.request('PUT', '/api/admin/settings', { token: owner, body: { profile: { ...base, accent: 'teal', logo: png } } })).status, 200)
  const inst = (await h.request('GET', '/api/instance')).body
  assert.equal(inst['accent'], 'teal')
  assert.equal(inst['logo'], png)
  for (const bad of [{ accent: 'neon' }, { logo: 'data:image/svg+xml;base64,PHN2Zz4=' }, { logo: 'https://evil.example/x.png' }, { logo: `data:image/png;base64,${'A'.repeat(70 * 1024)}` }]) {
    assert.equal((await h.request('PUT', '/api/admin/settings', { token: owner, body: { profile: { ...base, ...bad } } })).status, 400, JSON.stringify(bad).slice(0, 40))
  }
})

test('a direct share is between two people: a third invitation is refused; it says what kind it is', async () => {
  const { h, owner, ana, ben } = await people()
  const orgId = uuid()
  const orgKey = generateOrgKey()
  assert.equal((await h.request('POST', '/api/orgs', { token: owner.token, body: {
    id: orgId, kind: 'direct', hint: 'Shared with ana', label: 'Me', nameBlob: await sealOrgMeta(orgId, { name: 'You & ana', peer: ana.email }, orgKey), orgKeyBlob: await sealOrgKey(owner.keys.publicKey, orgKey, orgId),
  } })).status, 201)
  const mine = (await h.request('GET', '/api/orgs', { token: owner.token })).body['orgs'] as { id: string; kind: string }[]
  assert.equal(mine.find((o) => o.id === orgId)!.kind, 'direct')
  assert.equal((await h.request('POST', `/api/orgs/${orgId}/invites`, { token: owner.token, body: { email: ana.email } })).status, 201)
  assert.equal((await h.request('POST', `/api/orgs/${orgId}/invites`, { token: owner.token, body: { email: ana.email, label: 'Ana again' } })).status, 201, 're-inviting the same person is fine')
  const third = await h.request('POST', `/api/orgs/${orgId}/invites`, { token: owner.token, body: { email: ben.email } })
  assert.equal(third.status, 409)
  assert.match(String(third.body['message']), /between two people/)
  const team = await newOrg(h, owner, 'Team')
  const teams = (await h.request('GET', '/api/orgs', { token: owner.token })).body['orgs'] as { id: string; kind: string }[]
  assert.equal(teams.find((o) => o.id === team.orgId)!.kind, 'team')
})

// ── Notification centre, access requests and check-outs, sensitive items (E10, D7, D12)

const notes = async (h: H, token: string) => (await h.request('GET', '/api/notifications', { token })).body as { notes: { id: string; kind: string; read: boolean; data: Record<string, unknown> }[]; unread: number }

test('a member asks for a collection; admins are told; a check-out grants it for hours, then it ends', async () => {
  const { h, owner, ana } = await people()
  const org = await newOrg(h, owner)
  await join(h, owner, ana, org, 'Ana')
  // Members see collections they cannot open, so they can ask.
  const cols = (await h.request('GET', `/api/orgs/${org.orgId}/collections`, { token: ana.token })).body['collections'] as { id: string; access: unknown; requested?: boolean }[]
  assert.deepEqual(cols.map((c) => [c.id, c.access]), [[org.collId, null]])
  assert.equal((await h.request('GET', `/api/orgs/${org.orgId}/collections/${org.collId}/items`, { token: ana.token })).status, 404, 'seeing the name is not opening it')

  assert.equal((await h.request('POST', `/api/orgs/${org.orgId}/collections/${org.collId}/request`, { token: ana.token, body: { reason: 'Quarter-end close' } })).status, 201)
  const ownerNotes = await notes(h, owner.token)
  const req = ownerNotes.notes.find((n) => n.kind === 'access-request')!
  assert.equal(req.data['who'], 'Ana')
  assert.equal(req.data['reason'], 'Quarter-end close')
  assert.equal(((await h.request('GET', `/api/orgs/${org.orgId}/requests`, { token: owner.token })).body['requests'] as unknown[]).length, 1)
  assert.equal((await h.request('GET', `/api/orgs/${org.orgId}/requests`, { token: ana.token })).status, 403)
  assert.equal(((await h.request('GET', `/api/orgs/${org.orgId}/collections`, { token: ana.token })).body['collections'] as { requested?: boolean }[])[0]!.requested, true)

  assert.equal((await h.request('PUT', `/api/orgs/${org.orgId}/collections/${org.collId}/access/${ana.userId}`, { token: owner.token, body: {
    permission: 'view', hours: 5, keyBlob: await sealCollectionKey(ana.keys.publicKey, org.collKey, org.collId, 1),
  } })).status, 400, 'only offered lengths')
  assert.equal((await h.request('PUT', `/api/orgs/${org.orgId}/collections/${org.collId}/access/${ana.userId}`, { token: owner.token, body: {
    permission: 'view', hours: 8, keyBlob: await sealCollectionKey(ana.keys.publicKey, org.collKey, org.collId, 1),
  } })).status, 200)
  const granted = (await notes(h, ana.token)).notes.find((n) => n.kind === 'access-granted')!
  assert.ok(granted.data['until'])
  assert.equal((await h.request('GET', `/api/orgs/${org.orgId}/collections/${org.collId}/items`, { token: ana.token })).status, 200)
  assert.equal(((await h.request('GET', `/api/orgs/${org.orgId}/requests`, { token: owner.token })).body['requests'] as unknown[]).length, 0, 'fulfilled')

  h.setNow(h.app.now() + 9 * 3_600_000)
  // Her token from setup has expired by now; sign in again.
  const anaAgain = String((await h.request('POST', '/api/auth/login', { body: { email: ana.email, authKey: fixtureB64(ana.email) } })).body['accessToken'])
  const ownerAgain = String((await h.request('POST', '/api/auth/login', { body: { email: owner.email, authKey: fixtureB64(owner.email) } })).body['accessToken'])
  assert.equal((await h.request('GET', `/api/orgs/${org.orgId}/collections/${org.collId}/items`, { token: anaAgain })).status, 404, 'the check-out ran out')
  assert.ok((await notes(h, anaAgain)).notes.some((n) => n.kind === 'access-ended'))
  const col = ((await h.request('GET', `/api/orgs/${org.orgId}/collections`, { token: ownerAgain })).body['collections'] as { rotationNeeded: boolean }[])[0]!
  assert.equal(col.rotationNeeded, true, 'her copy of the key should be retired')
})

test('a request can be turned down, and the member is told', async () => {
  const { h, owner, ana } = await people()
  const org = await newOrg(h, owner)
  await join(h, owner, ana, org, 'Ana')
  await h.request('POST', `/api/orgs/${org.orgId}/collections/${org.collId}/request`, { token: ana.token, body: {} })
  assert.equal((await h.request('DELETE', `/api/orgs/${org.orgId}/collections/${org.collId}/request/${ana.userId}`, { token: ana.token })).status, 404)
  assert.equal((await h.request('DELETE', `/api/orgs/${org.orgId}/collections/${org.collId}/request/${ana.userId}`, { token: owner.token })).status, 200)
  assert.ok((await notes(h, ana.token)).notes.some((n) => n.kind === 'access-denied'))
})

test('sensitive items: managers mark them; members opening them is reported to managers', async () => {
  const x = await orgWithItems()
  const { h, owner, ana, orgId, collId, items } = x
  assert.equal((await h.request('PUT', `/api/orgs/${orgId}/collections/${collId}/items/${items[0]}/sensitive`, { token: ana.token, body: { sensitive: true } })).status, 403, 'edit is not manage')
  assert.equal((await h.request('PUT', `/api/orgs/${orgId}/collections/${collId}/items/${items[0]}/sensitive`, { token: owner.token, body: { sensitive: true } })).status, 200)
  const list = (await h.request('GET', `/api/orgs/${orgId}/collections/${collId}/items`, { token: ana.token })).body['items'] as { id: string; sensitive?: boolean }[]
  assert.equal(list.find((i) => i.id === items[0])!.sensitive, true)
  // An edit keeps the mark.
  await h.request('PUT', `/api/orgs/${orgId}/collections/${collId}/items/${items[0]}`, { token: owner.token, body: { blob: sealedBlob('again'), keyVersion: 1 } })
  await h.request('POST', `/api/orgs/${orgId}/events`, { token: ana.token, body: { action: 'reveal', collectionId: collId, itemId: items[0] } })
  await h.request('POST', `/api/orgs/${orgId}/events`, { token: ana.token, body: { action: 'view', collectionId: collId, itemId: items[1] } })
  const ownerNotes = (await notes(h, owner.token)).notes.filter((n) => n.kind === 'sensitive-opened')
  assert.equal(ownerNotes.length, 1, 'only the sensitive one')
  assert.deepEqual([ownerNotes[0]!.data['who'], ownerNotes[0]!.data['action'], ownerNotes[0]!.data['itemId']], ['Ana', 'reveal', items[0]])
  assert.ok(!(await notes(h, ana.token)).notes.some((n) => n.kind === 'sensitive-opened'))
})

test('invitations and acceptances notify; notifications are read one by one or all at once', async () => {
  const { h, owner, ben } = await people()
  const org = await newOrg(h, owner)
  await h.request('POST', `/api/orgs/${org.orgId}/invites`, { token: owner.token, body: { email: ben.email, label: 'Ben' } })
  let b = await notes(h, ben.token)
  assert.equal(b.notes[0]!.kind, 'org-invite')
  assert.equal(b.unread, 1)
  await h.request('POST', `/api/orgs/${org.orgId}/accept`, { token: ben.token })
  const o = await notes(h, owner.token)
  assert.ok(o.notes.some((n) => n.kind === 'member-accepted' && n.data['who'] === 'Ben'))
  b = (await h.request('POST', '/api/notifications/read', { token: ben.token, body: { ids: [b.notes[0]!.id] } })).body as typeof b
  assert.equal(b.unread, 0)
  assert.equal((await h.request('POST', '/api/notifications/read', { token: owner.token, body: { all: true } })).body['unread'], 0)
  assert.equal((await h.request('POST', '/api/notifications/read', { token: owner.token, body: {} })).status, 400)
  assert.ok(!JSON.stringify(h.store.dump().filter((r) => r.sk.startsWith('NOTE#'))).includes(ben.email), 'no addresses in notifications')
})
