// Talking to a Vault server from the command line, the way the browser
// extension does (decisions/0036): the account step once, at `vault login`,
// then the master password each time the vault is needed. The vault key and
// decrypted items live in this process's memory only and are wiped after.
//
// Kept on disk (~/.config/vault-cli/config.json, mode 600): the server, the
// address and the account sign-in token. That token only asks to unlock; it
// opens nothing without the master password.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  type KdfParams, costOf, deriveAccountProof, deriveLoginKeys, fromBase64Url, generateTotp, kdfProblem, openEntry,
  parseSecretKey, unwrapVaultKey, wipe,
} from '@vault/crypto'

import type { Item } from './refs.js'

export interface Config { server: string; email: string; accountToken: string }

export const configPath = () => process.env['VAULT_CLI_CONFIG'] ?? join(process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), 'vault-cli', 'config.json')

export function loadConfig(): Config | null {
  const p = configPath()
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf8')) as Config } catch { return null }
}

export function saveConfig(c: Config | null): void {
  const p = configPath()
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 })
  writeFileSync(p, c ? JSON.stringify(c, null, 2) : '{}', { mode: 0o600 })
  chmodSync(p, 0o600)
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

async function call<T>(server: string, method: string, path: string, opts: { body?: unknown; token?: string } = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${server.replace(/\/$/, '')}${path}`, {
      method,
      headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { 'x-vault-auth': `Bearer ${opts.token}` } : {}), 'user-agent': 'vault-cli/0.1' },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    })
  } catch { throw new ApiError(0, 'network', `Could not reach ${server}.`) }
  const text = await res.text()
  let json: Record<string, unknown> = {}
  try { json = text ? JSON.parse(text) as Record<string, unknown> : {} } catch { /* a proxy page */ }
  if (!res.ok) throw new ApiError(res.status, String(json['error'] ?? 'error'), String(json['message'] ?? `The server answered ${res.status}.`))
  return json as T
}

/** The account step (`vault login`): account password, and a second factor
 *  when the account has one (asked for through `secondFactor`). */
export async function login(server: string, email: string, accountPassword: string, secondFactor: () => Promise<string>): Promise<Config> {
  const { account } = await call<{ account: { salt: string; m: number; t: number; p: number } }>(server, 'POST', '/api/auth/account/prelogin', { body: { email } })
  const proof = await deriveAccountProof(accountPassword, account)
  let r: { accountToken: string; kdf: KdfParams | null }
  try {
    r = await call(server, 'POST', '/api/auth/account/login', { body: { email, accountProof: proof } })
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== 'two_factor_required') throw err
    const code = (await secondFactor()).trim()
    const second = /^\d{6,8}$/.test(code) ? { totpCode: code } : { recoveryCode: code }
    r = await call(server, 'POST', '/api/auth/account/login', { body: { email, accountProof: proof, ...second } })
  }
  if (!r.kdf) throw new Error('This account has no vault yet. Create it in the web app first.')
  return { server: server.replace(/\/$/, ''), email, accountToken: r.accountToken }
}

export async function logout(c: Config): Promise<void> {
  await call(c.server, 'POST', '/api/auth/account/signout', { body: { accountToken: c.accountToken } }).catch(() => {})
}

interface Unlocked { items: Item[]; totp: (secret: string) => Promise<string>; done: () => Promise<void> }

/** Unlocks with the master password, reads and decrypts the vault, and
 *  signs the vault session out again. The account token is replaced on every
 *  unlock (0036); the new one is saved. */
export async function unlock(c: Config, masterPassword: string, secretKeyText?: string): Promise<Unlocked> {
  const { kdf } = await call<{ account: unknown; kdf?: KdfParams }>(c.server, 'POST', '/api/auth/account/session', { body: { accountToken: c.accountToken } })
    .catch((err: unknown) => { if (err instanceof ApiError && err.status === 401) throw new Error('Signed out: run `vault login` again.'); throw err }) as { kdf?: KdfParams }
  if (!kdf) throw new Error('This account has no vault yet.')
  if (kdfProblem(kdf)) throw new Error('The server sent key settings Vault does not use; nothing was derived.')
  const secretKey = kdf.version === 2 ? (secretKeyText ? await parseSecretKey(secretKeyText) : null) : undefined
  if (secretKey === null) throw new Error('This account uses a secret key: set VAULT_SECRET_KEY to the one in your Emergency Kit.')
  const keys = await deriveLoginKeys(masterPassword, fromBase64Url(kdf.salt), costOf(kdf), secretKey ?? undefined)
  let res: { accountToken: string; wrappedVaultKey: string; accessToken: string; refreshToken: string }
  try {
    res = await call(c.server, 'POST', '/api/auth/unlock', { body: { accountToken: c.accountToken, authKey: keys.authKey } })
  } catch (err) {
    // A wrong password still hands back the replacement token (0036).
    if (err instanceof ApiError && err.status === 401) throw new Error('Wrong master password.')
    throw err
  } finally { secretKey?.fill(0) }
  saveConfig({ ...c, accountToken: res.accountToken })
  const vaultKey = await unwrapVaultKey(res.wrappedVaultKey, keys.kek, 'master')
  wipe(keys.kek)
  try {
    const vault = await call<{ entries: { id: string; blob: string }[] }>(c.server, 'GET', '/api/vault', { token: res.accessToken })
    const items: Item[] = []
    for (const e of vault.entries) {
      try {
        const content = await openEntry(e.id, e.blob, vaultKey)
        if (content.archived) continue
        items.push({
          id: e.id, name: content.name, ...(content.username ? { username: content.username } : {}), ...(content.password ? { password: content.password } : {}),
          ...(content.url ? { url: content.url } : {}), ...(content.notes ? { notes: content.notes } : {}), ...(content.totpSecret ? { totpSecret: content.totpSecret } : {}),
          customFields: content.customFields ?? [], ...(content.fields ? { fields: content.fields } : {}),
        })
      } catch { /* an entry this key cannot open is skipped */ }
    }
    return {
      items,
      totp: async (secret) => (await generateTotp(secret)).code,
      done: async () => { await call(c.server, 'POST', '/api/auth/logout', { token: res.accessToken, body: { refreshToken: res.refreshToken } }).catch(() => {}) },
    }
  } finally { wipe(vaultKey) }
}
