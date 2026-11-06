// Recovery, and the master password change that the key hierarchy exists to
// make cheap.

import test from 'node:test'
import assert from 'node:assert/strict'

import { fixtureB64, harness, registration, sealedBlob } from './harness.js'

const b64 = (label: string) => fixtureB64(`recovery-test.${label}`)
const sealed = (label: string) => sealedBlob(`recovery-test.${label}`, 48)

test('the recovery key opens the account without the master password', async () => {
  const h = harness()
  const reg = registration()
  await h.request('POST', '/api/auth/register', { body: reg })

  const res = await h.request('POST', '/api/auth/recovery-login', {
    body: { email: reg['email'], recoveryAuthKey: reg['recoveryAuthKey'] },
  })
  assert.equal(res.status, 200)
  assert.equal(res.body['wrappedVaultKeyForRecovery'], reg['wrappedVaultKeyForRecovery'])
  assert.ok(typeof res.body['accessToken'] === 'string')
})

test('the recovery-wrapped key is never handed to an unauthenticated caller', async () => {
  // Without the recovery proof there is no way to obtain it — not from
  // prelogin, not from a failed recovery attempt.
  const h = harness()
  const reg = registration()
  await h.request('POST', '/api/auth/register', { body: reg })

  const pre = await h.request('POST', '/api/auth/prelogin', { body: { email: reg['email'] } })
  assert.ok(!JSON.stringify(pre.body).includes(String(reg['wrappedVaultKeyForRecovery'])))

  const wrong = await h.request('POST', '/api/auth/recovery-login', {
    body: { email: reg['email'], recoveryAuthKey: b64('v200') },
  })
  assert.equal(wrong.status, 401)
  assert.ok(!JSON.stringify(wrong.body).includes(String(reg['wrappedVaultKeyForRecovery'])))
})

test('the master password auth key cannot stand in for the recovery proof', async () => {
  // The two are separate HKDF branches; confusing them would collapse the
  // separation the design depends on.
  const h = harness()
  const reg = registration()
  await h.request('POST', '/api/auth/register', { body: reg })

  const res = await h.request('POST', '/api/auth/recovery-login', {
    body: { email: reg['email'], recoveryAuthKey: reg['authKey'] },
  })
  assert.equal(res.status, 401)
})

test('using the recovery key drops every existing session', async () => {
  // A recovery key in use means the master password is believed lost, which is
  // a plausible sign the account is contested.
  const h = harness()
  const reg = registration()
  const first = await h.request('POST', '/api/auth/register', { body: reg })

  await h.request('POST', '/api/auth/recovery-login', {
    body: { email: reg['email'], recoveryAuthKey: reg['recoveryAuthKey'] },
  })

  const after = await h.request('POST', '/api/auth/refresh', {
    body: { refreshToken: String(first.body['refreshToken']) },
  })
  assert.equal(after.status, 401)
})

test('changing the master password rewrites one item and no entries', async () => {
  // The central claim of decisions/0001. If this stops holding, a password
  // change becomes an O(n) rewrite that cannot be done atomically.
  const h = harness()
  const reg = registration()
  const session = await h.request('POST', '/api/auth/register', { body: reg })
  const token = String(session.body['accessToken'])

  for (const id of ['entry-aaaaaaaa', 'entry-bbbbbbbb', 'entry-cccccccc']) {
    await h.request('PUT', `/api/vault/entries/${id}`, { token, body: { blob: sealed('v7') } })
  }
  const before = h.store.dump().filter((i) => i.sk.startsWith('ENTRY#'))

  const changed = await h.request('POST', '/api/auth/change-password', {
    token,
    body: {
      currentAuthKey: reg['authKey'],
      newAuthKey: b64('v50'),
      kdf: { algorithm: 'PBKDF2-HMAC-SHA256', iterations: 600_000, salt: b64('v51') },
      wrappedVaultKey: sealed('v52'),
    },
  })
  assert.equal(changed.status, 200)

  const after = h.store.dump().filter((i) => i.sk.startsWith('ENTRY#'))
  assert.deepEqual(after, before, 'not one entry was touched')
})

test('the old password stops working and the new one starts', async () => {
  const h = harness()
  const reg = registration()
  const session = await h.request('POST', '/api/auth/register', { body: reg })

  await h.request('POST', '/api/auth/change-password', {
    token: String(session.body['accessToken']),
    body: {
      currentAuthKey: reg['authKey'],
      newAuthKey: b64('v50'),
      kdf: { algorithm: 'PBKDF2-HMAC-SHA256', iterations: 600_000, salt: b64('v51') },
      wrappedVaultKey: sealed('v52'),
    },
  })

  const old = await h.request('POST', '/api/auth/login', {
    body: { email: reg['email'], authKey: reg['authKey'] },
  })
  assert.equal(old.status, 401)

  const fresh = await h.request('POST', '/api/auth/login', {
    body: { email: reg['email'], authKey: b64('v50') },
  })
  assert.equal(fresh.status, 200)
  assert.equal(fresh.body['wrappedVaultKey'], sealed('v52'))
})

test('changing the password requires proving the current one', async () => {
  // Holding an access token is not enough, so a stolen token cannot be used to
  // lock the owner out of their own vault.
  const h = harness()
  const reg = registration()
  const session = await h.request('POST', '/api/auth/register', { body: reg })

  const res = await h.request('POST', '/api/auth/change-password', {
    token: String(session.body['accessToken']),
    body: {
      currentAuthKey: b64('v123'),
      newAuthKey: b64('v50'),
      kdf: { algorithm: 'PBKDF2-HMAC-SHA256', iterations: 600_000, salt: b64('v51') },
      wrappedVaultKey: sealed('v52'),
    },
  })
  assert.equal(res.status, 401)
})

test('the recovery key still works after a password change', async () => {
  // The recovery wrapping derives from the recovery key alone. Losing this
  // would silently strand the only backup.
  const h = harness()
  const reg = registration()
  const session = await h.request('POST', '/api/auth/register', { body: reg })

  await h.request('POST', '/api/auth/change-password', {
    token: String(session.body['accessToken']),
    body: {
      currentAuthKey: reg['authKey'],
      newAuthKey: b64('v50'),
      kdf: { algorithm: 'PBKDF2-HMAC-SHA256', iterations: 600_000, salt: b64('v51') },
      wrappedVaultKey: sealed('v52'),
    },
  })

  const res = await h.request('POST', '/api/auth/recovery-login', {
    body: { email: reg['email'], recoveryAuthKey: reg['recoveryAuthKey'] },
  })
  assert.equal(res.status, 200)
})

test('rotating the recovery key invalidates the previous one', async () => {
  const h = harness()
  const reg = registration()
  const session = await h.request('POST', '/api/auth/register', { body: reg })
  const token = String(session.body['accessToken'])

  await h.request('POST', '/api/auth/recovery/rotate', {
    token, body: { currentAuthKey: reg['authKey'], recoveryAuthKey: b64('v70'), wrappedVaultKeyForRecovery: sealed('v71') },
  })

  const old = await h.request('POST', '/api/auth/recovery-login', {
    body: { email: reg['email'], recoveryAuthKey: reg['recoveryAuthKey'] },
  })
  assert.equal(old.status, 401)

  const fresh = await h.request('POST', '/api/auth/recovery-login', {
    body: { email: reg['email'], recoveryAuthKey: b64('v70') },
  })
  assert.equal(fresh.status, 200)
  assert.equal(fresh.body['wrappedVaultKeyForRecovery'], sealed('v71'))
})

test('security events are recorded with an expiry', async () => {
  const h = harness()
  const reg = registration()
  const session = await h.request('POST', '/api/auth/register', { body: reg })

  const events = (await h.request('GET', '/api/activity', {
    token: String(session.body['accessToken']),
  })).body['events'] as { kind: string }[]
  assert.ok(events.some((e) => e.kind === 'register'))

  for (const item of h.store.dump().filter((i) => i.sk.startsWith('ACT#'))) {
    assert.equal(typeof item['expiresAt'], 'number', 'TTL set, so the log cannot grow without bound')
  }
})

test('after signing in with the recovery key, a new master password can be set with it', async () => {
  const h = harness()
  const reg = registration()
  await h.request('POST', '/api/auth/register', { body: reg })
  const rec = await h.request('POST', '/api/auth/recovery-login', {
    body: { email: reg['email'], recoveryAuthKey: reg['recoveryAuthKey'] },
  })
  const changed = await h.request('POST', '/api/auth/change-password', {
    token: String(rec.body['accessToken']),
    body: {
      recoveryAuthKey: reg['recoveryAuthKey'],
      newAuthKey: b64('reset-new'),
      kdf: { algorithm: 'PBKDF2-HMAC-SHA256', iterations: 600_000, salt: b64('reset-salt') },
      wrappedVaultKey: sealed('reset-wrapped'),
    },
  })
  assert.equal(changed.status, 200)
  const login = await h.request('POST', '/api/auth/login', { body: { email: reg['email'], authKey: b64('reset-new') } })
  assert.equal(login.status, 200)
  assert.equal(login.body['wrappedVaultKey'], sealed('reset-wrapped'))
})

test('a wrong recovery proof cannot set a new master password', async () => {
  const h = harness()
  const reg = registration()
  const session = await h.request('POST', '/api/auth/register', { body: reg })
  const res = await h.request('POST', '/api/auth/change-password', {
    token: String(session.body['accessToken']),
    body: {
      recoveryAuthKey: b64('not-the-recovery-key'),
      newAuthKey: b64('n1'),
      kdf: { algorithm: 'PBKDF2-HMAC-SHA256', iterations: 600_000, salt: b64('n2') },
      wrappedVaultKey: sealed('n3'),
    },
  })
  assert.equal(res.status, 401)
})

test('a password change needs one proof or the other', async () => {
  const h = harness()
  const reg = registration()
  const session = await h.request('POST', '/api/auth/register', { body: reg })
  const res = await h.request('POST', '/api/auth/change-password', {
    token: String(session.body['accessToken']),
    body: { newAuthKey: b64('n1'), kdf: { algorithm: 'PBKDF2-HMAC-SHA256', iterations: 600_000, salt: b64('n2') }, wrappedVaultKey: sealed('n3') },
  })
  assert.equal(res.status, 400)
})

test('rotating the recovery key needs the current password, not just a session', async () => {
  const h = harness()
  const reg = registration()
  const session = await h.request('POST', '/api/auth/register', { body: reg })
  const token = String(session.body['accessToken'])
  const noProof = await h.request('POST', '/api/auth/recovery/rotate', {
    token, body: { recoveryAuthKey: b64('r1'), wrappedVaultKeyForRecovery: sealed('r2') },
  })
  assert.equal(noProof.status, 400)
  const wrongProof = await h.request('POST', '/api/auth/recovery/rotate', {
    token, body: { currentAuthKey: b64('wrong'), recoveryAuthKey: b64('r1'), wrappedVaultKeyForRecovery: sealed('r2') },
  })
  assert.equal(wrongProof.status, 401)
  // The original recovery key still works.
  const still = await h.request('POST', '/api/auth/recovery-login', {
    body: { email: reg['email'], recoveryAuthKey: reg['recoveryAuthKey'] },
  })
  assert.equal(still.status, 200)
})
