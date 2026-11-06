// What an unlocked vault holds, and where it holds it.
//
// In memory, in a module-level variable, and nowhere else. Not localStorage,
// not sessionStorage, not IndexedDB, not a cookie. The consequence is that a
// page reload locks the vault and the master password has to be typed again —
// a deliberate trade against convenience, and the reason a stolen laptop with
// a closed tab yields nothing.
//
// See docs/threat-model.md, A5.

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
export function patch(fields: Partial<Pick<Unlocked, 'userId' | 'isAdmin' | 'role' | 'permissions'>>): void {
  if (!current) return
  current = { ...current, ...fields }
  notify()
}

let current: Unlocked | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null

/** Long enough not to interrupt ordinary use, short enough that a vault left
 *  open on an unattended screen does not stay open. */
const IDLE_MS = 15 * 60 * 1000

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
  if (current) wipe(current.vaultKey)
  current = null
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  notify()
}

export function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(lock, IDLE_MS)
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
// form. There is nothing persisted to clear, so this only drops the live copy.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', lock)
  for (const event of ['click', 'keydown', 'pointermove'] as const) {
    window.addEventListener(event, () => {
      if (current) resetIdleTimer()
    }, { passive: true })
  }
}
