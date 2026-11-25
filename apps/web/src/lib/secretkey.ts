// The secret key on this device (decisions/0027).
//
// Typed once per browser, then kept in IndexedDB sealed with a device key:
// an AES-GCM CryptoKey created non-extractable, so script on this origin can
// use it but nobody can copy its bytes out, and a copy of the browser profile's
// files alone does not reveal the secret key in readable form.
//
// The device's copy also guards sign-in. If this browser holds a secret key
// for an address and the server answers that the account has none, sign-in
// stops: a server that drops the flag would otherwise receive an auth key
// derived from the password alone, which it could attack offline.

import { type KdfParams, costOf, deriveLoginKeys, fromBase64Url, normalizeEmail, toBase64Url } from '@vault/crypto'

const DB = 'vault-device'
const STORE = 'keys'
const DEVICE = 'device-key.v1'
const AAD = new TextEncoder().encode('vault.secret-key.device.v1')

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE) }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB is unavailable.'))
  })
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open()
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed.'))
    })
  } finally { db.close() }
}

async function deviceKey(): Promise<CryptoKey> {
  const existing = await tx<CryptoKey | undefined>('readonly', (s) => s.get(DEVICE) as IDBRequest<CryptoKey | undefined>)
  if (existing) return existing
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  await tx('readwrite', (s) => s.put(key, DEVICE))
  return key
}

const slot = (email: string) => `sk:${normalizeEmail(email)}`

export async function storeSecretKey(email: string, secretKey: Uint8Array): Promise<void> {
  const key = await deviceKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, secretKey as Uint8Array<ArrayBuffer>))
  await tx('readwrite', (s) => s.put({ iv: toBase64Url(iv), ct: toBase64Url(ct) }, slot(email)))
}

/** The secret key this browser holds for an address, or null. */
export async function loadSecretKey(email: string): Promise<Uint8Array | null> {
  try {
    const row = await tx<{ iv: string; ct: string } | undefined>('readonly', (s) => s.get(slot(email)) as IDBRequest<{ iv: string; ct: string } | undefined>)
    if (!row) return null
    const key = await deviceKey()
    const iv = fromBase64Url(row.iv) as Uint8Array<ArrayBuffer>
    const ct = fromBase64Url(row.ct) as Uint8Array<ArrayBuffer>
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, ct))
  } catch {
    return null
  }
}

export async function forgetSecretKey(email: string): Promise<void> {
  try { await tx('readwrite', (s) => s.delete(slot(email))) } catch { /* nothing stored */ }
}

export class MissingSecretKey extends Error {
  constructor() {
    super('This browser does not hold your secret key. Sign out, then sign in again with the secret key from your Emergency Kit.')
    this.name = 'MissingSecretKey'
  }
}

/** The secret key an account's KDF parameters call for, from this device. */
export async function secretKeyFor(email: string, kdf: KdfParams): Promise<Uint8Array | undefined> {
  if (kdf.version !== 2) return undefined
  const key = await loadSecretKey(email)
  if (!key) throw new MissingSecretKey()
  return key
}

/** Derive an unlocked account's login keys from its master password, with the
 *  secret key when it has one. */
export async function deriveForAccount(state: { email: string; kdf: KdfParams }, password: string) {
  const sk = await secretKeyFor(state.email, state.kdf)
  try {
    return await deriveLoginKeys(password, fromBase64Url(state.kdf.salt), costOf(state.kdf), sk)
  } finally { sk?.fill(0) }
}
