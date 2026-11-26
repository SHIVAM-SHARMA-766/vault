// Single sign-on against a real identity provider (decisions/0021): Keycloak
// in a container, with tests/keycloak/vault-realm.json imported. The other
// SSO tests use a mock; this one proves discovery, PKCE, client
// authentication and ID-token checks work with a provider we did not write.
//
//   docker run -p 127.0.0.1:8089:8080 -v $PWD/tests/keycloak:/opt/keycloak/data/import:ro \
//     quay.io/keycloak/keycloak:26.0.7 start-dev --import-realm
//   KEYCLOAK_URL=http://localhost:8089 node --test tests/keycloak/

import test from 'node:test'
import assert from 'node:assert/strict'

import { PASSWORD, start } from '../e2e/helpers.mjs'

const KC = process.env.KEYCLOAK_URL

test('sign in through Keycloak, then the master password', { skip: !KC && 'KEYCLOAK_URL is not set' }, async () => {
  const s = await start({ env: { OIDC_ISSUER: `${KC}/realms/vault`, OIDC_CLIENT_ID: 'vault-ci', OIDC_CLIENT_SECRET: 'vault-ci-secret-not-for-production', OIDC_NAME: 'Keycloak' } })
  try {
    const owner = await s.person()
    await s.register(owner, 'owner@example.test')
    await s.setRegistration(true)
    const person = await s.person()
    await s.register(person, 'kc-person@example.test')
    await person.getByRole('button', { name: 'Lock vault' }).click()

    await person.getByRole('link', { name: 'Sign in with Keycloak' }).click()
    // Keycloak's own login page.
    await person.waitForSelector('#username', { timeout: 30_000 })
    assert.ok(person.url().startsWith(`${KC}/realms/vault/protocol/openid-connect/auth`))
    await person.fill('#username', 'kc-person')
    await person.fill('#password', 'keycloak-test-password')
    await person.click('#kc-login')

    await person.waitForSelector('.sso-banner', { timeout: 30_000 })
    assert.match(await person.textContent('.sso-banner'), /Keycloak signed you in as kc-person@example\.test/)
    await person.fill('#password', PASSWORD)
    await person.click('button[type=submit]')
    await person.waitForSelector('.topbar', { timeout: 60_000 })
    assert.deepEqual(s.errors, [])
  } finally {
    await s.stop()
  }
})
