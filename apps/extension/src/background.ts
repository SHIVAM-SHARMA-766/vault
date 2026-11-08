// The extension's background (decisions/0029): the only place the vault key
// is held, and the only code that talks to the server.
//
// Unlocked state lives in chrome.storage.session: in memory, never on disk,
// gone when the browser closes, and not readable by content scripts. The
// decrypted items are cached in this worker's memory only and rebuilt from the
// server when the worker restarts.

import { matchSite, rankForPage } from '@vault/core'
import {
  type EntryContent,
  type KdfParams,
  SecretKeyFormatError,
  deriveLoginKeys,
  fromBase64Url,
  generateTotp,
  openEntry,
  parseSecretKey,
  toBase64Url,
  unwrapVaultKey,
  wipe,
} from '@vault/crypto'

import { forgetSecretKey, loadSecretKey, storeSecretKey } from '../../web/src/lib/secretkey.js'
import { ApiError, api } from './api.js'
import { fillLogin } from './fill.js'
import type { ItemSummary, ItemsReply, Request, StateReply, UnlockReply, Wire } from './messages.js'

interface Server { url: string; name: string }
interface Unlocked {
  email: string
  vaultKey: string
  accessToken: string
  refreshToken: string
  accessExpiresAt: number
  kdf: KdfParams
  idleMinutes: number
  lastActive: number
}
type Item = EntryContent & { id: string }

const DEFAULT_IDLE_MINUTES = 15

class Locked extends Error { constructor() { super('Vault is locked.'); this.name = 'Locked' } }

// ── State ────────────────────────────────────────────────────────────────────

const getServer = async (): Promise<Server | null> => ((await chrome.storage.local.get('server'))['server'] as Server | undefined) ?? null
const getUnlocked = async (): Promise<Unlocked | null> => ((await chrome.storage.session.get('unlocked'))['unlocked'] as Unlocked | undefined) ?? null
const saveUnlocked = (u: Unlocked) => chrome.storage.session.set({ unlocked: u })

let cache: Item[] | null = null
let used: Record<string, number> | null = null

async function usedAt(): Promise<Record<string, number>> {
  used ??= ((await chrome.storage.session.get('used'))['used'] as Record<string, number> | undefined) ?? {}
  return used
}
async function markUsed(id: string) {
  const u = await usedAt()
  u[id] = Date.now()
  await chrome.storage.session.set({ used: u })
}

async function lock(): Promise<void> {
  const u = await getUnlocked()
  const server = await getServer()
  cache = null
  used = null
  await chrome.storage.session.clear()
  // End this device's session on the server too, so locked browsers do not
  // pile up in Settings → Devices. Best effort: locking never waits on it.
  if (u && server) void api(server.url).logout(u.accessToken).catch(() => {})
}

async function touch() {
  const u = await getUnlocked()
  if (u) await saveUnlocked({ ...u, lastActive: Date.now() })
}

/** A fresh access token. Refreshes are serialised: two at once would present
 *  the same refresh token twice, which the server treats as a replay. */
let refreshing: Promise<string> | null = null
async function token(): Promise<string> {
  const u = await getUnlocked()
  if (!u) throw new Locked()
  if (Date.now() < u.accessExpiresAt - 60_000) return u.accessToken
  refreshing ??= (async () => {
    const server = await getServer()
    try {
      if (!server) throw new Locked()
      const next = await api(server.url).refresh(u.refreshToken)
      await saveUnlocked({ ...u, accessToken: next.accessToken, refreshToken: next.refreshToken, accessExpiresAt: Date.now() + next.expiresIn * 1000 })
      return next.accessToken
    } catch {
      await lock()
      throw new Locked()
    }
  })().finally(() => { refreshing = null })
  return refreshing
}

async function items(): Promise<Item[]> {
  if (cache) return cache
  const u = await getUnlocked()
  const server = await getServer()
  if (!u || !server) throw new Locked()
  const vault = await api(server.url).vault(await token())
  const key = fromBase64Url(u.vaultKey)
  try {
    const opened = await Promise.all(vault.entries.map(async (e) => {
      try { return { ...(await openEntry(e.id, e.blob, key)), id: e.id } } catch { return null }
    }))
    cache = opened.filter((x): x is Item => x !== null && !x.archived).sort((a, b) => a.name.localeCompare(b.name))
  } finally { wipe(key) }
  return cache
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function setServer(input: string): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  let url: URL
  try { url = new URL(/^[a-z]+:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`) } catch { return { ok: false, error: 'That is not a web address.' } }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return { ok: false, error: 'Use the https:// address of your Vault server.' }
  const origin = url.origin
  if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) return { ok: false, error: 'The extension needs permission to reach that server.' }
  try {
    const instance = await api(origin).instance()
    await lock()
    await chrome.storage.local.set({ server: { url: origin, name: instance.name || 'Vault' } satisfies Server })
    return { ok: true, name: instance.name || 'Vault' }
  } catch {
    return { ok: false, error: 'No Vault server answered at that address.' }
  }
}

async function unlock(req: Extract<Request, { type: 'unlock' }>): Promise<UnlockReply> {
  const server = await getServer()
  if (!server) return { ok: false, error: 'Choose your Vault server first.' }
  const a = api(server.url)
  const email = req.email.trim()

  let typed: Uint8Array | undefined
  try { typed = req.secretKey?.trim() ? await parseSecretKey(req.secretKey) : undefined }
  catch (err) { return { ok: false, needSecretKey: true, error: err instanceof SecretKeyFormatError ? err.message : 'That is not a valid secret key.' } }

  let kdf: KdfParams
  try { ({ kdf } = await a.prelogin(email)) } catch (err) { return { ok: false, error: err instanceof Error ? err.message : 'Could not reach the server.' } }

  // The web app's rule (decisions/0027): a secret key held here is always
  // used, and a server that says the account has none is not answered.
  const held = await loadSecretKey(email)
  if (held && kdf.version !== 2) {
    held.fill(0)
    return { ok: false, heldButRefused: true, error: 'This browser holds a secret key for this account, but the server says the account has none. If you removed it, forget it here; otherwise do not continue.' }
  }
  const secretKey = held ?? typed
  if (kdf.version === 2 && !secretKey) return { ok: false, needSecretKey: true, error: 'This account uses a secret key. Enter it from your Emergency Kit; this browser keeps it after that.' }

  const keys = await deriveLoginKeys(req.password, fromBase64Url(kdf.salt), kdf.iterations, kdf.version === 2 ? secretKey : undefined)
  if (held) held.fill(0)
  try {
    let res
    try {
      res = await a.login(email, keys.authKey, req.second)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'two_factor_required') {
        const methods = ((err.details as { methods?: string[] } | undefined)?.methods ?? ['totp', 'recovery']).filter((m) => m !== 'webauthn')
        return {
          ok: false, needSecond: methods,
          error: methods.includes('totp') ? 'Enter the code from your authenticator app.'
            : 'A security key cannot be used from the extension. Enter one of your recovery codes.',
        }
      }
      if (err instanceof ApiError && err.status === 401) {
        return { ok: false, error: kdf.version === 2 ? 'Wrong email, master password or secret key.' : 'Wrong email or master password.', ...(req.second ? { needSecond: [] } : {}) }
      }
      return { ok: false, error: err instanceof Error ? err.message : 'Could not sign in.' }
    }
    const vaultKey = await unwrapVaultKey(res.wrappedVaultKey, keys.kek, 'master')
    if (typed && !held) await storeSecretKey(email, typed).catch(() => {})
    let idleMinutes = DEFAULT_IDLE_MINUTES
    try { idleMinutes = (await a.me(res.accessToken)).policy.maxIdleMinutes ?? DEFAULT_IDLE_MINUTES } catch { /* the default */ }
    cache = null
    await saveUnlocked({
      email, vaultKey: toBase64Url(vaultKey), accessToken: res.accessToken, refreshToken: res.refreshToken,
      accessExpiresAt: Date.now() + res.expiresIn * 1000, kdf: res.kdf, idleMinutes, lastActive: Date.now(),
    })
    wipe(vaultKey)
    await chrome.alarms.create('idle', { periodInMinutes: 1 })
    return { ok: true }
  } finally {
    wipe(keys.kek)
    typed?.fill(0)
  }
}

const summary = (e: Item): ItemSummary => ({
  id: e.id, name: e.name, username: e.username ?? '', host: e.url ? hostOfUrl(e.url) : '',
  hasPassword: !!e.password, hasTotp: !!e.totpSecret, favorite: e.favorite,
})
function hostOfUrl(url: string): string {
  try { return new URL(url.includes('://') ? url : `https://${url}`).hostname } catch { return url }
}

async function listItems(pageUrl?: string): Promise<ItemsReply> {
  const all = await items()
  const u = await usedAt()
  const matches = pageUrl ? rankForPage(all, pageUrl, (e) => e.url, (e) => u[e.id] ?? 0).map((e) => e.id) : []
  return { items: all.map(summary), matches }
}

async function find(id: string): Promise<Item> {
  const item = (await items()).find((e) => e.id === id)
  if (!item) throw new Error('That item is no longer in your vault.')
  return item
}

async function fill(id: string, tabId: number): Promise<{ filled: number; error?: string }> {
  const item = await find(id)
  // The tab's URL, as the browser reports it — never as the popup says.
  const tab = await chrome.tabs.get(tabId)
  if (!tab.url) return { filled: 0, error: 'This page cannot be filled.' }
  if (!matchSite(item.url, tab.url)) return { filled: 0, error: `This item is not for ${hostOfUrl(tab.url)}.` }
  const origin = new URL(tab.url).origin
  const [result] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func: fillLogin,
    args: [item.username ?? '', item.password ?? '', origin],
  })
  const filled = (result?.result as { filled: number } | undefined)?.filled ?? 0
  if (filled) await markUsed(id)
  return filled ? { filled } : { filled: 0, error: 'No login form was found on this page.' }
}

async function reveal(id: string, field: 'username' | 'password' | 'totp'): Promise<{ value: string | null; expiresIn?: number }> {
  const item = await find(id)
  await markUsed(id)
  if (field === 'totp') {
    if (!item.totpSecret) return { value: null }
    const code = await generateTotp(item.totpSecret.replace(/\s+/g, ''))
    return { value: code.code, expiresIn: code.secondsRemaining }
  }
  return { value: (field === 'username' ? item.username : item.password) ?? null }
}

/** Locks when the idle limit has passed. Checked by the alarm and before
 *  every request, so a computer that slept through the alarm still locks. */
async function lockIfIdle(): Promise<void> {
  const u = await getUnlocked()
  if (u && Date.now() - u.lastActive > u.idleMinutes * 60_000) await lock()
}

async function handle(req: Request): Promise<unknown> {
  await lockIfIdle()
  if (req.type !== 'state') await touch()
  switch (req.type) {
    case 'state': {
      const server = await getServer()
      const u = await getUnlocked()
      return { server: server?.url ?? null, serverName: server?.name ?? null, locked: !u, email: u?.email ?? null } satisfies StateReply
    }
    case 'setServer': return setServer(req.url)
    case 'forgetServer': await lock(); await chrome.storage.local.remove('server'); return { ok: true }
    case 'unlock': return unlock(req)
    case 'forgetSecretKey': await forgetSecretKey(req.email); return { ok: true }
    case 'items': return listItems(req.pageUrl)
    case 'reveal': return reveal(req.id, req.field)
    case 'fill': return fill(req.id, req.tabId)
    case 'sync': cache = null; await items(); return { ok: true }
    case 'lock': await lock(); return { ok: true }
  }
}

// Only this extension's own pages may ask; it has no content scripts, and a
// web page cannot message it at all (no externally_connectable).
chrome.runtime.onMessage.addListener((message: Request, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false
  handle(message).then(
    (result) => sendResponse({ result } satisfies Wire<unknown>),
    (err: unknown) => sendResponse({ error: err instanceof Error ? err.message : 'Something went wrong.', locked: err instanceof Locked } satisfies Wire<unknown>),
  )
  return true
})

// The fill shortcut: the best match for the page, if there is one.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'fill-login' || !tab?.id || !tab.url) return
  void (async () => {
    await lockIfIdle()
    if (!(await getUnlocked())) { await chrome.action.openPopup().catch(() => {}); return }
    await touch()
    const { matches } = await listItems(tab.url)
    if (matches[0]) await fill(matches[0], tab.id!)
  })().catch(() => {})
})

// Idle lock: the account's limit, checked every minute.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'idle') return
  void (async () => {
    if (!(await getUnlocked())) { await chrome.alarms.clear('idle'); return }
    await lockIfIdle()
  })()
})
