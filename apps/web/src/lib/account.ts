// The account sign-in (decisions/0036), kept by this browser so that day to
// day only the master password is typed. What is kept opens nothing: the
// account token is good only for asking to unlock, which also needs the
// master password's proof. Signing out of this device forgets it.

import { ACCOUNT_KDF, type AccountParams, costOf, deriveAccountProof, deriveLoginKeys, fromBase64Url, newAccountParams } from '@vault/crypto'

import { type KdfParams, api } from './api.js'

export interface AccountSession { email: string; accountToken: string; kdf: KdfParams }

const KEY = 'vault.account.v1'
const listeners = new Set<() => void>()

export function loadAccount(): AccountSession | null {
  try {
    const raw = localStorage.getItem(KEY)
    const v = raw ? JSON.parse(raw) as AccountSession : null
    return v && typeof v.email === 'string' && typeof v.accountToken === 'string' && v.kdf ? v : null
  } catch { return null }
}

export function saveAccount(s: AccountSession): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)) } catch { /* private window: only this tab keeps it */ }
  memory = s
  for (const l of listeners) l()
}

let memory: AccountSession | null = null
/** The stored sign-in, or the one this tab made when storage is unavailable. */
export const currentAccount = (): AccountSession | null => loadAccount() ?? memory

export function forgetAccount(): void {
  try { localStorage.removeItem(KEY) } catch { /* nothing kept */ }
  memory = null
  for (const l of listeners) l()
}

export function onAccountChange(l: () => void): () => void { listeners.add(l); return () => listeners.delete(l) }

/** Signs this device out of the account (the server forgets the token too). */
export async function signOutAccount(): Promise<void> {
  const a = currentAccount()
  forgetAccount()
  if (a) await api.account.signOut(a.accountToken).catch(() => {})
}

/** What setting an account password sends: new settings, the proof, and the
 *  check that it is not the master password's text (`masterCheck`). */
export async function accountPasswordPayload(password: string, kdf: KdfParams): Promise<{ account: AccountParams & { proof: string }; masterCheck: string }> {
  const params = newAccountParams()
  const [proof, check] = await Promise.all([
    deriveAccountProof(password, params),
    deriveLoginKeys(password, fromBase64Url(kdf.salt), costOf(kdf)).then((k) => { k.kek.fill(0); return k.authKey }),
  ])
  return { account: { ...params, proof }, masterCheck: check }
}

export { ACCOUNT_KDF, deriveAccountProof }
