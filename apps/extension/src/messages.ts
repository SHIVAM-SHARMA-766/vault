// What the popup may ask the background, and what it gets back. The popup is
// given only what it shows or copies; the vault key never leaves the background.

/** The URLs the inline content script may run on (decisions/0029, stage 3):
 *  every site, as an optional permission the person grants. The test build
 *  uses the loopback addresses it already holds, so no prompt has to be
 *  clicked. */
declare const __VAULT_TEST__: boolean
export const INLINE_ORIGINS = __VAULT_TEST__ ? ['http://127.0.0.1/*', 'http://localhost/*'] : ['https://*/*', 'http://*/*']

export interface ItemSummary {
  id: string
  name: string
  username: string
  host: string
  hasPassword: boolean
  hasTotp: boolean
  favorite: boolean
  /** Where a shared item lives ("Acme / Finance"); absent for your own. */
  where?: string
  /** The collection hides passwords: it can be filled, not copied (0015). */
  passwordHidden?: boolean
}

export type SecondFactorInput = { totpCode: string } | { recoveryCode: string }

export type Request =
  | { type: 'state' }
  | { type: 'setServer'; url: string }
  | { type: 'forgetServer' }
  | { type: 'unlock'; email: string; password: string; secretKey?: string; second?: SecondFactorInput }
  | { type: 'forgetSecretKey'; email: string }
  | { type: 'items'; pageUrl?: string }
  | { type: 'reveal'; id: string; field: 'username' | 'password' | 'totp' }
  | { type: 'fill'; id: string; tabId: number }
  | { type: 'sync' }
  | { type: 'lock' }
  | { type: 'setInline'; on: boolean }
  | { type: 'setPasskeys'; on: boolean }

export interface StateReply { server: string | null; serverName: string | null; locked: boolean; email: string | null; inline: boolean; passkeys: boolean }

export type UnlockReply =
  | { ok: true }
  | { ok: false; error: string; needSecretKey?: boolean; heldButRefused?: boolean; needSecond?: string[] }

/** `notice`: something the person should know, such as a shared collection
 *  whose key was refused (0025). */
export interface ItemsReply { items: ItemSummary[]; matches: string[]; notice?: string }

export type Reply<R extends Request> =
  R extends { type: 'state' } ? StateReply
  : R extends { type: 'setServer' } ? { ok: true; name: string } | { ok: false; error: string }
  : R extends { type: 'setInline' } ? { ok: true } | { ok: false; error: string }
  : R extends { type: 'setPasskeys' } ? { ok: true } | { ok: false; error: string }
  : R extends { type: 'unlock' } ? UnlockReply
  : R extends { type: 'items' } ? ItemsReply
  : R extends { type: 'reveal' } ? { value: string | null; expiresIn?: number }
  : R extends { type: 'fill' } ? { filled: number; error?: string }
  : { ok: true }

/** Errors cross the message channel as data, not exceptions. */
export type Wire<T> = { result: T } | { error: string; locked?: boolean }

export async function ask<R extends Request>(request: R): Promise<Reply<R>> {
  const wire = (await chrome.runtime.sendMessage(request)) as Wire<Reply<R>> | undefined
  if (!wire) throw new Error('The extension did not answer. Try again.')
  if ('error' in wire) { const e = new Error(wire.error) as Error & { locked?: boolean }; e.locked = wire.locked; throw e }
  return wire.result
}
