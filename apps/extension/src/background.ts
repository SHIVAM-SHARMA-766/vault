// The extension's background (decisions/0029): the only place the vault key
// is held, and the only code that talks to the server.
//
// Unlocked state lives in chrome.storage.session: in memory, never on disk,
// gone when the browser closes, and not readable by content scripts. The
// decrypted items are cached in this worker's memory only and rebuilt from the
// server when the worker restarts.

import { DEFAULT_PREFS, type GeneratorPrefs, effectiveLockMinutes, generateFromPrefs, matchSite, normalizePrefs, rankForPage } from '@vault/core'
import { WORDS } from '@vault/core/words'
import {
  type EntryContent,
  type KdfParams,
  SecretKeyFormatError,
  costOf,
  deriveLoginKeys,
  kdfProblem,
  fromBase64Url,
  generateTotp,
  openCollectionKey,
  openCollectionMeta,
  openEntry,
  openOrgKey,
  openOrgMeta,
  openSharedItem,
  parseSecretKey,
  sealEntry,
  sealHistory,
  unsealJson,
  utf8Encode,
  toBase64Url,
  unwrapIdentityPrivateKey,
  unwrapVaultKey,
  wipe,
} from '@vault/crypto'

import { checkGrant, openTrust, sealTrust, trustedSigners } from '../../web/src/features/orgs/grants.js'
import { forgetSecretKey, loadSecretKey, storeSecretKey } from '../../web/src/lib/secretkey.js'
import { ApiError, api } from './api.js'
import { fillLogin } from './fill.js'
import { INLINE_ORIGINS, type ItemSummary, type ItemsReply, type Request, type StateReply, type UnlockReply, type Wire } from './messages.js'

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
  /** The account's generator preferences (Settings → Preferences). */
  generator?: GeneratorPrefs
}
/** `fill`: the collection's permission set allows filling (decisions/0032, 2b). */
interface Shared { orgId: string; collectionId: string; where: string; hidePasswords: boolean; fill: boolean; sensitive: boolean }
/** `key` is unique across the vault and shared collections; `id` is the
 *  item's own id where it lives. */
type Item = EntryContent & { id: string; key: string; shared?: Shared }

const DEFAULT_IDLE_MINUTES = 15

class Locked extends Error { constructor() { super('Vault is locked.'); this.name = 'Locked' } }

// ── State ────────────────────────────────────────────────────────────────────

const getServer = async (): Promise<Server | null> => ((await chrome.storage.local.get('server'))['server'] as Server | undefined) ?? null
const getUnlocked = async (): Promise<Unlocked | null> => ((await chrome.storage.session.get('unlocked'))['unlocked'] as Unlocked | undefined) ?? null
const saveUnlocked = (u: Unlocked) => chrome.storage.session.set({ unlocked: u })

let cache: Item[] | null = null
let notice: string | undefined
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
  notice = undefined
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
  const a = api(server.url)
  const token1 = await token()
  const key = fromBase64Url(u.vaultKey)
  try {
    const vault = await a.vault(token1)
    const own = (await Promise.all(vault.entries.map(async (e) => {
      try { return { ...(await openEntry(e.id, e.blob, key)), id: e.id, key: e.id } } catch { return null }
    }))).filter((x): x is Item => x !== null && !x.archived)
    // Shared collections are best effort: a problem there must not hide the
    // person's own vault.
    let shared: Item[] = []
    notice = undefined
    try {
      // A personal Vault has no organizations (decisions/0030).
      const orgsOn = (await a.instance().catch(() => null))?.features?.organizations ?? true
      const res = orgsOn ? await loadShared(server.url, token1, key) : { items: [], refused: 0, idle: [] }
      shared = res.items
      if (res.refused) notice = `${res.refused} shared collection${res.refused === 1 ? ' was' : 's were'} not opened: the key was not signed by an admin you trust. Open Vault to check.`
      // The strictest idle limit among organizations sets the lock, as in the web app.
      if (res.idle.length) {
        const limit = Math.min(u.idleMinutes, ...res.idle)
        const now = await getUnlocked()
        if (now && limit < now.idleMinutes) await saveUnlocked({ ...now, idleMinutes: limit })
      }
    } catch {
      notice = 'Shared collections could not be loaded. Your own items are shown.'
    }
    cache = [...own, ...shared].sort((x, y) => x.name.localeCompare(y.name))
  } finally { wipe(key) }
  return cache
}

/** Every shared collection this account may open, decrypted (decisions/0015).
 *  Each grant is checked as the web app checks it (0025, grants.ts): a key
 *  whose signature fails against a trusted admin is not used. Nothing is
 *  written here except pinning the owner on first sight, as the web app does. */
async function loadShared(server: string, token1: string, vaultKey: Uint8Array): Promise<{ items: Item[]; refused: number; idle: number[] }> {
  const a = api(server)
  const me = await a.me(token1)
  const out: Item[] = []
  const idle: number[] = []
  let refused = 0
  if (!me.identity) return { items: out, refused, idle }
  const publicKey = fromBase64Url(me.identity.publicKey)
  const privateKey = await unwrapIdentityPrivateKey(me.identity.wrappedPrivateKey, vaultKey)
  try {
    for (const row of (await a.orgs(token1)).orgs) {
      if (row.status !== 'confirmed' || !row.orgKeyBlob) continue
      if (row.policies.maxIdleMinutes) idle.push(row.policies.maxIdleMinutes)
      if (row.policyGap) continue
      const orgKey = await openOrgKey(privateKey, publicKey, row.orgKeyBlob, row.id)
      try {
        const orgName = (await openOrgMeta(row.id, row.nameBlob, orgKey)).name
        const members = (await a.members(token1, row.id).catch(() => ({ members: [] }))).members
        const trust = await openTrust(row.id, vaultKey, (await a.getTrust(token1, row.id).catch(() => ({ blob: null }))).blob)
        const ts = await trustedSigners(row.id, members, trust, async (t) => { await a.putTrust(token1, row.id, await sealTrust(row.id, vaultKey, t)).catch(() => {}) })
        for (const c of (await a.collections(token1, row.id)).collections) {
          if (!c.access || c.access.keyVersion !== c.keyVersion) continue
          const status = await checkGrant(row.id, c.id, c.keyVersion, c.access,
            { publicKey: me.identity.publicKey, signingKey: me.identity.signingPublicKey ?? null, userId: me.userId }, ts.signers, ts.trust)
          if (status === 'bad') { refused++; continue }
          const collKey = await openCollectionKey(privateKey, publicKey, c.access.keyBlob, c.id, c.keyVersion)
          try {
            const name = (await openCollectionMeta(row.id, c.id, c.nameBlob, orgKey).catch(() => ({ name: 'Collection' }))).name
            const where = row.kind === 'direct' ? name : `${orgName} / ${name}`
            for (const it of (await a.items(token1, row.id, c.id)).items) {
              try {
                // `exposed` and `sensitive` are the server's word, never the blob's.
                const { exposed: _x, sensitive: _s, ...content } = (await openSharedItem(c.id, it.id, it.keyVersion, it.blob, collKey)) as EntryContent & { exposed?: unknown; sensitive?: unknown }
                if (content.archived) continue
                out.push({ ...content, id: it.id, key: `${c.id}/${it.id}`, shared: { orgId: row.id, collectionId: c.id, where, hidePasswords: c.access.hidePasswords, fill: c.access.rights?.fill ?? true, sensitive: !!it.sensitive } })
              } catch { /* an item under an older key; rotation re-seals it */ }
            }
          } finally { wipe(collKey) }
        }
      } finally { wipe(orgKey) }
    }
  } finally { wipe(privateKey) }
  return { items: out, refused, idle }
}

/** Tell the organization a shared item was filled or copied (its audit, and
 *  its admins when the item is sensitive). Best effort. */
async function report(item: Item, action: 'copy' | 'fill') {
  if (!item.shared) return
  const server = await getServer()
  if (!server) return
  try { await api(server.url).report(await token(), item.shared.orgId, action, item.shared.collectionId, item.id) } catch { /* the action still happened */ }
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

  // Argon2id or PBKDF2, as the account says (decisions/0028), within limits.
  if (kdfProblem(kdf)) return { ok: false, error: 'The server sent key settings Vault does not use, so nothing was derived.' }
  const keys = await deriveLoginKeys(req.password, fromBase64Url(kdf.salt), costOf(kdf), kdf.version === 2 ? secretKey : undefined)
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
    // The person's own auto-lock and generator choices (sealed preferences),
    // shortened by the server's policy, as in the web app.
    let idleMinutes = DEFAULT_IDLE_MINUTES
    let generator: GeneratorPrefs = DEFAULT_PREFS.generator
    try {
      const [me, prefsBlob] = await Promise.all([a.me(res.accessToken), a.prefs(res.accessToken).catch(() => ({ blob: null }))])
      const prefs = prefsBlob.blob ? normalizePrefs(await unsealJson(vaultKey, prefsBlob.blob, utf8Encode('vault.prefs.v1'))) : DEFAULT_PREFS
      idleMinutes = effectiveLockMinutes(prefs, me.policy.maxIdleMinutes)
      generator = prefs.generator
    } catch { /* the defaults */ }
    cache = null
    await saveUnlocked({
      email, vaultKey: toBase64Url(vaultKey), accessToken: res.accessToken, refreshToken: res.refreshToken,
      accessExpiresAt: Date.now() + res.expiresIn * 1000, kdf: res.kdf, idleMinutes, generator, lastActive: Date.now(),
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
  id: e.key, name: e.name, username: e.username ?? '', host: e.url ? hostOfUrl(e.url) : '',
  hasPassword: !!e.password, hasTotp: !!e.totpSecret, favorite: e.favorite,
  ...(e.shared ? { where: e.shared.where, ...(e.shared.hidePasswords ? { passwordHidden: true } : {}) } : {}),
})
function hostOfUrl(url: string): string {
  try { return new URL(url.includes('://') ? url : `https://${url}`).hostname } catch { return url }
}

async function listItems(pageUrl?: string): Promise<ItemsReply> {
  const all = await items()
  const u = await usedAt()
  // A shared item whose permission set does not allow filling is not offered (2b).
  const fillable = all.filter((e) => e.shared?.fill !== false)
  const matches = pageUrl ? rankForPage(fillable, pageUrl, (e) => e.url, (e) => u[e.key] ?? 0).map((e) => e.key) : []
  return { items: all.map(summary), matches, ...(notice ? { notice } : {}) }
}

async function find(id: string): Promise<Item> {
  const item = (await items()).find((e) => e.key === id)
  if (!item) throw new Error('That item is no longer in your vault.')
  return item
}

async function fill(id: string, tabId: number): Promise<{ filled: number; error?: string }> {
  const item = await find(id)
  if (item.shared?.fill === false) return { filled: 0, error: 'Your organization does not allow filling this item.' }
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
  if (filled) { await markUsed(id); void report(item, 'fill') }
  return filled ? { filled } : { filled: 0, error: 'No login form was found on this page.' }
}

async function reveal(id: string, field: 'username' | 'password' | 'totp'): Promise<{ value: string | null; expiresIn?: number }> {
  const item = await find(id)
  // "Hide passwords" is the organization's policy, kept by the app (0015).
  if (field === 'password' && item.shared?.hidePasswords) throw new Error('Your organization hides this password. It can be filled, not copied.')
  await markUsed(id)
  void report(item, 'copy')
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
      return { server: server?.url ?? null, serverName: server?.name ?? null, locked: !u, email: u?.email ?? null, inline: await inlineOn() } satisfies StateReply
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
    case 'setInline': return setInline(req.on)
  }
}

// ── Inside pages (stage 3) ───────────────────────────────────────────────────

const INLINE_ID = 'vault-inline'

async function inlineOn(): Promise<boolean> { return ((await chrome.storage.local.get('inline'))['inline'] as boolean | undefined) ?? false }

async function setInline(on: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  const registered = (await chrome.scripting.getRegisteredContentScripts({ ids: [INLINE_ID] })).length > 0
  if (on) {
    if (!(await chrome.permissions.contains({ origins: INLINE_ORIGINS }))) return { ok: false, error: 'The extension needs permission to work inside pages.' }
    if (!registered) await chrome.scripting.registerContentScripts([{ id: INLINE_ID, js: ['content.js'], matches: INLINE_ORIGINS, runAt: 'document_idle', allFrames: false }])
  } else if (registered) {
    await chrome.scripting.unregisterContentScripts({ ids: [INLINE_ID] })
  }
  await chrome.storage.local.set({ inline: on })
  return { ok: true }
}

/** A submission still being compared with the vault, per tab. The next page
 *  often asks for its offer before that finishes; it waits for it. */
const submitting = new Map<number, Promise<unknown>>()

interface Pending { kind: 'save' | 'update'; key?: string; name?: string; url: string; host: string; username: string; password: string; at: number }
const OFFER_MS = 3 * 60_000

async function pendingFor(tabId: number): Promise<Pending | null> {
  const all = ((await chrome.storage.session.get('offers'))['offers'] as Record<string, Pending> | undefined) ?? {}
  const p = all[tabId]
  return p && Date.now() - p.at < OFFER_MS ? p : null
}
async function setPending(tabId: number, p: Pending | null) {
  const all = ((await chrome.storage.session.get('offers'))['offers'] as Record<string, Pending> | undefined) ?? {}
  if (p) all[tabId] = p; else delete all[tabId]
  await chrome.storage.session.set({ offers: all })
}

const hostLabel = (url: string) => hostOfUrl(url).replace(/^www\./, '')

/** What to offer after a password was submitted on a page: nothing when the
 *  vault already has it, an update when this site's login for the username
 *  has another password, a new login otherwise. Shared items are not edited
 *  from here. */
async function offerFor(url: string, username: string, password: string): Promise<Pending | null> {
  const all = await items()
  const here = all.filter((e) => matchSite(e.url, url))
  const same = (e: Item) => (e.username ?? '').toLowerCase() === username.toLowerCase()
  const candidates = username ? here.filter(same) : here.length === 1 ? here : []
  if (candidates.some((e) => e.password === password)) return null
  const mine = candidates.find((e) => !e.shared)
  if (candidates.length && !mine) return null
  const base = { url, host: hostLabel(url), username: username || mine?.username || '', password, at: Date.now() }
  return mine ? { ...base, kind: 'update', key: mine.key, name: mine.name } : { ...base, kind: 'save' }
}

/** Save a new login, or update one's password, keeping its previous version
 *  in history as the web app does. */
async function answer(p: Pending): Promise<void> {
  const u = await getUnlocked()
  const server = await getServer()
  if (!u || !server) throw new Locked()
  const a = api(server.url)
  const key = fromBase64Url(u.vaultKey)
  try {
    const now = new Date().toISOString()
    if (p.kind === 'update' && p.key) {
      const prev = (await items()).find((e) => e.key === p.key && !e.shared)
      if (!prev) return
      const { id, key: _k, shared: _s, ...before } = prev
      const after: EntryContent = { ...before, password: p.password, passwordChangedAt: now }
      const t = await token()
      await a.addHistory(t, id, await sealHistory(id, before, key))
      await a.putEntry(t, id, await sealEntry(id, after, key))
    } else {
      const id = crypto.randomUUID()
      let origin = p.url
      try { origin = new URL(p.url).origin } catch { /* as given */ }
      const entry: EntryContent = { name: p.host, type: 'login', username: p.username, password: p.password, url: origin, tags: [], customFields: [], favorite: false, passwordChangedAt: now }
      await a.putEntry(await token(), id, await sealEntry(id, entry, key))
    }
    cache = null
  } finally { wipe(key) }
}

type ContentRequest =
  | { type: 'inline:hello' }
  | { type: 'inline:list' }
  | { type: 'inline:fill'; id: string }
  | { type: 'inline:generate' }
  | { type: 'inline:submitted'; username: string; password: string }
  | { type: 'inline:offer' }
  | { type: 'inline:answer'; save: boolean }
  | { type: 'inline:unlock' }

/** A content script's question. The page's URL and tab come from the browser
 *  (the sender), never from the message. */
async function handleContent(req: ContentRequest, tab: chrome.tabs.Tab): Promise<unknown> {
  const url = tab.url ?? ''
  const tabId = tab.id!
  const server = await getServer()
  // Never on the Vault server's own pages: the master password is typed there.
  const ours = !!server && (() => { try { return new URL(url).origin === server.url } catch { return true } })()
  if (req.type === 'inline:hello') return { active: !ours && (await inlineOn()) }
  if (ours) return null
  await lockIfIdle()
  const unlocked = !!(await getUnlocked())
  switch (req.type) {
    case 'inline:list': {
      if (!unlocked) return { locked: true }
      await touch()
      const { matches, items: list } = await listItems(url)
      const byId = new Map(list.map((i) => [i.id, i]))
      return { matches: matches.map((id) => byId.get(id)!).map((i) => ({ id: i.id, name: i.name, username: i.username })) }
    }
    case 'inline:fill': if (!unlocked) return { locked: true }; await touch(); return fill(req.id, tabId)
    case 'inline:generate': {
      const g = (await getUnlocked())?.generator ?? DEFAULT_PREFS.generator
      return { password: generateFromPrefs(g, WORDS) }
    }
    case 'inline:submitted': {
      // Locked: nothing is kept. Unlocked: an offer, held in session memory.
      if (!unlocked || !req.password || req.password.length > 1024) return {}
      const work = (async () => {
        const o = await offerFor(url, req.username.slice(0, 512), req.password)
        await setPending(tabId, o)
        return o
      })()
      submitting.set(tabId, work)
      const offer = await work.finally(() => { if (submitting.get(tabId) === work) submitting.delete(tabId) })
      return offer ? { offer: { kind: offer.kind, host: offer.host, username: offer.username, ...(offer.name ? { name: offer.name } : {}) } } : {}
    }
    case 'inline:offer': {
      await submitting.get(tabId)?.catch(() => {})
      const p = await pendingFor(tabId)
      // Only on the site it was captured on (or the same site's next page).
      if (!p || !unlocked || !matchSite(p.url, url)) return {}
      return { offer: { kind: p.kind, host: p.host, username: p.username, ...(p.name ? { name: p.name } : {}) } }
    }
    case 'inline:answer': {
      const p = await pendingFor(tabId)
      await setPending(tabId, null)
      if (req.save && p && matchSite(p.url, url)) { await touch(); await answer(p) }
      return { ok: true }
    }
    case 'inline:unlock': await chrome.action.openPopup().catch(() => {}); return { ok: true }
  }
}

// This extension's own pages may ask anything; its inline content script,
// in the top frame of a tab, only the inline questions. A web page cannot
// message it at all (no externally_connectable).
chrome.runtime.onMessage.addListener((message: Request | ContentRequest, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false
  const reply = (p: Promise<unknown>) => p.then(
    (result) => sendResponse({ result } satisfies Wire<unknown>),
    (err: unknown) => sendResponse({ error: err instanceof Error ? err.message : 'Something went wrong.', locked: err instanceof Locked } satisfies Wire<unknown>),
  )
  if (sender.tab?.id !== undefined && sender.frameId === 0 && message.type.startsWith('inline:') && !sender.url?.startsWith(chrome.runtime.getURL(''))) {
    reply(handleContent(message as ContentRequest, sender.tab))
    return true
  }
  if (!sender.url?.startsWith(chrome.runtime.getURL(''))) return false
  reply(handle(message as Request))
  return true
})

// Keep the inline script's registration in step with the setting, and with
// the permission, which the person can withdraw in the browser's settings.
async function syncInline() {
  const want = (await inlineOn()) && (await chrome.permissions.contains({ origins: INLINE_ORIGINS }))
  await setInline(want).catch(() => {})
}
chrome.runtime.onStartup.addListener(() => void syncInline())
chrome.runtime.onInstalled.addListener(() => void syncInline())
chrome.permissions.onRemoved.addListener(() => void syncInline())


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
