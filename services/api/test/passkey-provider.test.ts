// The extension's passkeys (decisions/0035), checked by an independent
// verifier: @simplewebauthn/server, as a relying party would run it, accepts
// the registration and the sign-in packages/core produces, and refuses one
// made for another origin or replayed against another challenge.

import test from 'node:test'
import assert from 'node:assert/strict'

import { assertPasskey, createPasskey } from '@vault/core'
import { verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server'

const ORIGIN = 'https://login.example.com'
const RP = 'example.com'

test('a relying party accepts a Vault passkey\'s registration and sign-in', async () => {
  const { stored, response } = await createPasskey({ rpId: RP, origin: ORIGIN, challenge: 'c2lnbi11cC1jaGFsbGVuZ2U', userHandle: 'dXNlci0x', userName: 'ana@example.com' })
  const reg = await verifyRegistrationResponse({
    response: { id: response.id, rawId: response.id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: response.clientDataJSON, attestationObject: response.attestationObject, transports: ['internal'] } },
    expectedChallenge: 'c2lnbi11cC1jaGFsbGVuZ2U', expectedOrigin: ORIGIN, expectedRPID: RP, requireUserVerification: true,
  })
  assert.equal(reg.verified, true)
  const info = reg.registrationInfo!
  assert.equal(info.credential.id, stored.credentialId)
  assert.equal(info.credentialBackedUp, true, 'it syncs with the vault')
  assert.equal(info.credentialDeviceType, 'multiDevice')

  const a = await assertPasskey(stored, { origin: ORIGIN, challenge: 'c2lnbi1pbi1jaGFsbGVuZ2U' })
  const auth = await verifyAuthenticationResponse({
    response: { id: a.id, rawId: a.id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: a.clientDataJSON, authenticatorData: a.authenticatorData, signature: a.signature, userHandle: a.userHandle } },
    expectedChallenge: 'c2lnbi1pbi1jaGFsbGVuZ2U', expectedOrigin: ORIGIN, expectedRPID: RP, requireUserVerification: true,
    credential: { id: info.credential.id, publicKey: info.credential.publicKey, counter: info.credential.counter },
  })
  assert.equal(auth.verified, true)

  // Made for another origin, or answering another challenge: refused.
  const elsewhere = await assertPasskey(stored, { origin: 'https://evil.example.net', challenge: 'c2lnbi1pbi1jaGFsbGVuZ2U' })
  await assert.rejects(verifyAuthenticationResponse({
    response: { id: elsewhere.id, rawId: elsewhere.id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: elsewhere.clientDataJSON, authenticatorData: elsewhere.authenticatorData, signature: elsewhere.signature } },
    expectedChallenge: 'c2lnbi1pbi1jaGFsbGVuZ2U', expectedOrigin: ORIGIN, expectedRPID: RP, credential: { id: info.credential.id, publicKey: info.credential.publicKey, counter: 0 },
  }))
  await assert.rejects(verifyAuthenticationResponse({
    response: { id: a.id, rawId: a.id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: a.clientDataJSON, authenticatorData: a.authenticatorData, signature: a.signature } },
    expectedChallenge: 'YW5vdGhlcg', expectedOrigin: ORIGIN, expectedRPID: RP, credential: { id: info.credential.id, publicKey: info.credential.publicKey, counter: 0 },
  }))
})
