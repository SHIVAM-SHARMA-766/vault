// What an unlocked vault holds, and where it holds it.
//
// In memory, in a module-level variable, and nowhere else. Not localStorage,
// not sessionStorage, not IndexedDB, not a cookie. The consequence is that a
// page reload locks the vault and the master password has to be typed again —
// a deliberate trade against convenience, and the reason a stolen laptop with
// a closed tab yields nothing.
//
// See docs/threat-model.md, A5.

import { effectiveLockMinutes } from '@vault/core'
import { wipe } from '@vault/crypto'

import { api, type KdfParams, type Permission, type Role, type Session } from './api.js'

export interface Unlocked {
  userId: string
  email: string
  /** Decrypts everything. Never leaves this module except to the crypto
   *  package, and never crosses the network in any form. */
  vaultKey: Uint8Array
  accessToken: string
  refreshToken: string
  kdf: KdfParams
  /** When the access token stops being accepted, as epoch milliseconds. */
  accessExpiresAt: number
  /** Whether the server lists this account as an operator. Only decides
   *  whether the admin panel is offered; every admin route checks again. */
  isAdmin?: boolean
  role?: Role
  permissions?: Permission[]
}

/** Updates fields of the unlocked state without touching the keys. */
export function patch(fields: Partial<Pick<Unlocked,
  'userId' | 'isAdmin' | 'role' | 'permissions' | 'kdf' | 'accessToken' | 'refreshToken' | 'accessExpiresAt'
>>): void {
  if (!current) return
  current = { ...current, ...fields }
  notify()
}

let current: Unlocked | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null

/** The idle lock is the person's choice (Settings → Preferences, fifteen
 *  minutes unless they change it), shortened by the strictest organization
 *  policy they are under. Neither can lengthen what the other set. */
let userIdleMinutes = 15
let policyIdleMinutes: number | null = null
let idleMs = 15 * 60_000
function updateIdle(): void {
  const next = effectiveLockMinutes({ lockMinutes: userIdleMinutes }, policyIdleMinutes) * 60_000
  if (next !== idleMs) { idleMs = next; if (current) resetIdleTimer() }
}
/** An organization's policy (null: none sets one). */
export function setIdleLimit(minutes: number | null): void { policyIdleMinutes = minutes; updateIdle() }
/** The person's own preference. */
export function setUserIdle(minutes: number): void { userIdleMinutes = minutes; updateIdle() }
/** Minutes until an idle vault locks, as things stand. */
export function idleMinutes(): number { return idleMs / 60_000 }

/** Lock the moment the tab is hidden (a preference, off by default). */
let lockOnHide = false
export function setLockOnHide(on: boolean): void { lockOnHide = on }

type Listener = (state: Unlocked | null) => void
const listeners = new Set<Listener>()

function notify(): void {
  for (const listener of listeners) listener(current)
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function get(): Unlocked | null {
  return current
}

export function unlock(state: Unlocked): void {
  current = state
  resetIdleTimer()
  notify()
}

/** Forgets everything. The vault key is overwritten first — best effort, since
 *  a JavaScript engine may have copied the bytes during garbage collection and
 *  nothing here can reach those copies, but the live copy is gone. */
export function lock(): void {
  // End the server session too, or every lock would leave a refresh token
  // alive for thirty days. keepalive lets it finish while the tab closes.
  if (current) {
    void fetch('/api/auth/signout', {
      method: 'POST', keepalive: true, credentials: 'omit', cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: current.refreshToken }),
    }).catch(() => { /* the session expires on its own */ })
    wipe(current.vaultKey)
  }
  current = null
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  notify()
}

export function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(lock, idleMs)
}

/** An access token good for at least the next minute, refreshing it if not.
 *
 *  Refresh tokens rotate: the server invalidates the one just used and issues
 *  a new pair. Presenting a rotated token twice is what the server treats as a
 *  stolen one, so the new pair must replace the old before anything else uses
 *  it. */
export async function token(): Promise<string> {
  if (!current) throw new Error('locked')

  if (Date.now() < current.accessExpiresAt - 60_000) {
    return current.accessToken
  }

  let next: Session
  try {
    next = await api.refresh(current.refreshToken)
  } catch {
    // The session is gone — expired, revoked, or refused as a replay. Locking
    // is the only honest response; the alternative is a UI that appears
    // signed in and fails every action.
    lock()
    throw new Error('locked')
  }

  current = {
    ...current,
    accessToken: next.accessToken,
    refreshToken: next.refreshToken,
    accessExpiresAt: Date.now() + next.expiresIn * 1000,
  }
  return current.accessToken
}

export function expiresAtFrom(session: Session): number {
  return Date.now() + session.expiresIn * 1000
}

// A closed or reloaded tab must not leave an unlocked vault behind in any
// form. There is nothing persisted to clear, so this drops the live copy and
// ends the server session.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', lock)
  document.addEventListener('visibilitychange', () => {
    if (lockOnHide && current && document.visibilityState === 'hidden') lock()
  })
  for (const event of ['click', 'keydown', 'pointermove'] as const) {
    window.addEventListener(event, () => {
      if (current) resetIdleTimer()
    }, { passive: true })
  }
}
