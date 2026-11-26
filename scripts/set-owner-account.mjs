// Gives an existing account its account password (decisions/0036) from the
// command line, signing in once with the master password as the app's
// "first sign-in since accounts" does. The operator uses it for their own
// account when they choose an account password equal to the master password,
// which the app's forms refuse (one leaked password then opens both).
//
//   BASE=https://vault.example.com EMAIL=… MASTER_PASSWORD=… ACCOUNT_PASSWORD=… \
//     node scripts/set-owner-account.mjs
//
// With REGISTER=1 (a fresh local dev stack), it creates the account instead.
// Nothing secret is printed.

import { costOf, createAccount, deriveAccountProof, deriveLoginKeys, deriveRecoveryProof, fromBase64Url, newAccountParams } from '../packages/crypto/dist/src/index.js'

const { BASE, EMAIL, MASTER_PASSWORD, ACCOUNT_PASSWORD } = process.env
if (!BASE || !EMAIL || !MASTER_PASSWORD || !ACCOUNT_PASSWORD) { console.error('Set BASE, EMAIL, MASTER_PASSWORD and ACCOUNT_PASSWORD.'); process.exit(1) }
const api = async (method, path, body, token) => {
  const res = await fetch(`${BASE.replace(/\/$/, '')}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { 'x-vault-auth': `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, body: json }
}

const params = newAccountParams()
const account = { ...params, proof: await deriveAccountProof(ACCOUNT_PASSWORD, params) }

if (process.env.REGISTER === '1') {
  const a = await createAccount(MASTER_PASSWORD)
  const r = await api('POST', '/api/auth/register', {
    email: EMAIL, authKey: a.authKey, recoveryAuthKey: await deriveRecoveryProof(a.recoveryKey), kdf: a.kdf,
    wrappedVaultKey: a.wrappedVaultKey, wrappedVaultKeyForRecovery: a.wrappedVaultKeyForRecovery, account,
  })
  console.log(r.status === 201 ? `created ${EMAIL}` : `not created: ${r.status} ${r.body.message ?? ''}`)
  process.exit(r.status === 201 ? 0 : 1)
}

const { body: pre } = await api('POST', '/api/auth/prelogin', { email: EMAIL })
const keys = await deriveLoginKeys(MASTER_PASSWORD, fromBase64Url(pre.kdf.salt), costOf(pre.kdf))
const login = await api('POST', '/api/auth/login', { email: EMAIL, authKey: keys.authKey })
if (login.body.error === 'account_password_required') { console.log(`${EMAIL} already has an account password; change it in Settings → Security.`); process.exit(0) }
if (login.status !== 200) { console.log(`sign-in refused: ${login.status} ${login.body.message ?? ''}`); process.exit(1) }
const set = await api('PUT', '/api/auth/account/password', { account }, login.body.accessToken)
console.log(set.status === 200 ? `account password set for ${EMAIL}` : `not set: ${set.status} ${set.body.message ?? ''}`)
await api('POST', '/api/auth/signout', { refreshToken: login.body.refreshToken })
process.exit(set.status === 200 ? 0 : 1)
