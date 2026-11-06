// Identity key enrolment: what the server accepts, what it refuses, and that a
// public key once set cannot be silently replaced.

import test from 'node:test'
import assert from 'node:assert/strict'

import { generateIdentityKeyPair, toBase64Url } from '@vault/crypto'

import { harness, registration, sealedBlob } from './harness.js'

async function identity() {
  const kp = await generateIdentityKeyPair()
  return { publicKey: toBase64Url(kp.publicKey), wrappedPrivateKey: sealedBlob('identity-private', 160) }
}

test('an account registered with an identity returns it from me', async () => {
  const h = harness()
  const id = await identity()
  const reg = await h.request('POST', '/api/auth/register', { body: registration({ identity: id }) })
  assert.equal(reg.status, 201)
  const me = await h.request('GET', '/api/auth/me', { token: String(reg.body['accessToken']) })
  assert.deepEqual(me.body['identity'], id)
})

test('an account without one can enrol exactly once', async () => {
  const h = harness()
  const reg = await h.request('POST', '/api/auth/register', { body: registration() })
  const token = String(reg.body['accessToken'])
  assert.equal((await h.request('GET', '/api/auth/me', { token })).body['identity'], null)

  const first = await identity()
  assert.equal((await h.request('PUT', '/api/keys/identity', { token, body: first })).status, 200)
  assert.deepEqual((await h.request('GET', '/api/auth/me', { token })).body['identity'], first)

  const replacement = await identity()
  assert.equal((await h.request('PUT', '/api/keys/identity', { token, body: replacement })).status, 409)
  assert.deepEqual((await h.request('GET', '/api/auth/me', { token })).body['identity'], first)
})

test('a public key that is not a point on the curve is refused', async () => {
  const h = harness()
  const reg = await h.request('POST', '/api/auth/register', { body: registration() })
  const fake = new Uint8Array(65).fill(9)
  fake[0] = 0x04
  const res = await h.request('PUT', '/api/keys/identity', {
    token: String(reg.body['accessToken']),
    body: { publicKey: toBase64Url(fake), wrappedPrivateKey: sealedBlob('x', 160) },
  })
  assert.equal(res.status, 400)
})

test('the private key must arrive sealed', async () => {
  const h = harness()
  const reg = await h.request('POST', '/api/auth/register', { body: registration() })
  const kp = await generateIdentityKeyPair()
  const res = await h.request('PUT', '/api/keys/identity', {
    token: String(reg.body['accessToken']),
    body: { publicKey: toBase64Url(kp.publicKey), wrappedPrivateKey: toBase64Url(kp.privateKey) },
  })
  assert.equal(res.status, 400)
})

test('enrolment needs a session', async () => {
  const h = harness()
  assert.equal((await h.request('PUT', '/api/keys/identity', { body: await identity() })).status, 401)
})
