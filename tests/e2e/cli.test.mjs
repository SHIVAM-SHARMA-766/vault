// The command-line client (admin console phase 5), against a real dev stack:
// sign in once, then read a secret and run a command with secrets in its
// environment. Nothing decrypted is written to disk.

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { createAccount, deriveAccountProof, deriveRecoveryProof, newAccountParams, sealEntry } from '../../packages/crypto/dist/src/index.js'
import { start } from './helpers.mjs'

const run = promisify(execFile)
const CLI = new URL('../../apps/cli/dist/src/main.js', import.meta.url).pathname
const MASTER = 'a long and unguessable cli passphrase'
const ACCOUNT = 'a different cli account passphrase'

test('vault login, read, list and run', async () => {
  const s = await start()
  try {
    // An account with one item, made the way the web app makes them.
    const a = await createAccount(MASTER)
    const params = newAccountParams()
    const post = (path, body, token) => fetch(`${s.base}${path}`, { method: path.includes('entries') ? 'PUT' : 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.88.0.1', ...(token ? { 'x-vault-auth': `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
    const reg = await (await post('/api/auth/register', {
      email: 'dev@example.test', authKey: a.authKey, recoveryAuthKey: await deriveRecoveryProof(a.recoveryKey), kdf: a.kdf,
      wrappedVaultKey: a.wrappedVaultKey, wrappedVaultKeyForRecovery: a.wrappedVaultKeyForRecovery, account: { ...params, proof: await deriveAccountProof(ACCOUNT, params) },
    })).json()
    const id = '0f3c2b1a-1111-4222-8333-944455556666'
    const blob = await sealEntry(id, { name: 'Stripe', type: 'login', username: 'billing', password: 'sk_live_secret', tags: [], customFields: [{ label: 'webhook', value: 'whsec_42', hidden: true }], favorite: false }, a.vaultKey)
    assert.ok([200, 201].includes((await post(`/api/vault/entries/${id}`, { blob }, reg.accessToken)).status))

    const dir = mkdtempSync(join(tmpdir(), 'vault-cli-'))
    const env = { ...process.env, VAULT_CLI_CONFIG: join(dir, 'config.json'), VAULT_ACCOUNT_PASSWORD: ACCOUNT, VAULT_MASTER_PASSWORD: MASTER }
    const cli = (...args) => run(process.execPath, [CLI, ...args], { env })

    await cli('login', '--server', s.base, '--email', 'dev@example.test')
    const config = JSON.parse(readFileSync(env.VAULT_CLI_CONFIG, 'utf8'))
    assert.deepEqual(Object.keys(config).sort(), ['accountToken', 'email', 'server'], 'no key and no secret on disk')

    assert.equal((await cli('read', 'vault://Stripe/password')).stdout, 'sk_live_secret')
    assert.equal((await cli('read', 'vault://stripe/webhook')).stdout, 'whsec_42')
    assert.match((await cli('list')).stdout, /^Stripe\tbilling$/m)
    await assert.rejects(cli('read', 'vault://Nope/password'), /No item named "Nope"/)

    writeFileSync(join(dir, '.env.vault'), 'STRIPE_KEY=vault://Stripe/password\nURL=https://billing:vault://Stripe/webhook@api.example\nPLAIN=yes\n')
    const out = (await cli('run', '--env-file', join(dir, '.env.vault'), '--', process.execPath, '-e',
      'console.log([process.env.STRIPE_KEY, process.env.URL, process.env.PLAIN, process.env.VAULT_MASTER_PASSWORD ?? "none"].join("|"))')).stdout.trim()
    assert.equal(out, 'sk_live_secret|https://billing:whsec_42@api.example|yes|none', 'secrets in, the master password out')

    // A wrong master password says so; logout forgets the sign-in.
    await assert.rejects(run(process.execPath, [CLI, 'read', 'vault://Stripe/password'], { env: { ...env, VAULT_MASTER_PASSWORD: 'wrong' } }), /Wrong master password/)
    await cli('logout')
    await assert.rejects(cli('read', 'vault://Stripe/password'), /Not signed in/)
  } finally {
    await s.stop()
  }
})
