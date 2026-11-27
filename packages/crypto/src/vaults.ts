// Several vaults in one account (Personal, Work, Family…).
//
// The account's own vault key is the Personal vault: entries with no vault id
// are sealed under it, exactly as before, so nothing existing moves. Every
// other vault has a random key of its own, wrapped under the account's vault
// key and bound to the vault's id, with its name and look sealed under that
// key. The server stores which vault an entry is in (an opaque id) and nothing
// about any vault but its id and size.
//
// A separate key per vault means one vault can later be handed to someone
// (emergency access, a family member) without the others, and a vault the
// server withholds (travel mode) stays closed even if a stale copy lingers.

import { sealJson, unsealJson, seal, unseal } from './aead.js'
import { utf8Encode } from './encoding.js'
import { randomBytes } from './random.js'

export const VAULT_KEY_BYTES = 32

/** What a vault says about itself, sealed under its own key. */
export interface VaultContent {
  name: string
  /** One of the app's icon names; presentation only. */
  icon?: string
  color?: string
}

/** A vault as the server keeps it. */
export interface SealedVault { id: string; key: string; blob: string }

/** A vault opened in this browser. */
export interface OpenVault extends VaultContent { id: string; key: Uint8Array }

const keyAad = (id: string) => utf8Encode(`vault.vaultkey.v1:${id}`)
const metaAad = (id: string) => utf8Encode(`vault.vaultmeta.v1:${id}`)

/** A new vault: a fresh key, wrapped under the account's vault key. */
export async function createVault(id: string, content: VaultContent, accountKey: Uint8Array): Promise<{ vault: OpenVault; sealed: SealedVault }> {
  const key = randomBytes(VAULT_KEY_BYTES)
  return { vault: { ...content, id, key }, sealed: await sealVault({ ...content, id, key }, accountKey) }
}

/** A vault ready to store: its key wrapped and its content sealed. */
export async function sealVault(vault: OpenVault, accountKey: Uint8Array): Promise<SealedVault> {
  const { id, key, ...content } = vault
  return { id, key: await seal(accountKey, key, keyAad(id)), blob: await sealJson(key, content, metaAad(id)) }
}

/** Opens the vaults the server holds. One that will not open (tampered, or
 *  from another account) is left out rather than failing the unlock. */
export async function openVaults(sealed: readonly SealedVault[], accountKey: Uint8Array): Promise<OpenVault[]> {
  const out: OpenVault[] = []
  for (const v of sealed) {
    try {
      const key = await unseal(accountKey, v.key, keyAad(v.id))
      if (key.length !== VAULT_KEY_BYTES) continue
      const content = await unsealJson<VaultContent>(key, v.blob, metaAad(v.id))
      out.push({ ...content, name: typeof content.name === 'string' ? content.name : 'Vault', id: v.id, key })
    } catch { /* not ours, or damaged: skipped */ }
  }
  return out
}

/** Which key opens an entry: its vault's, or the account's for Personal. */
export class Keyring {
  private readonly keys = new Map<string, Uint8Array>()
  constructor(readonly accountKey: Uint8Array, vaults: readonly OpenVault[] = []) {
    for (const v of vaults) this.keys.set(v.id, v.key)
  }

  /** The key for a vault id; null for one this browser cannot open. */
  keyFor(vaultId: string | null | undefined): Uint8Array | null {
    if (!vaultId) return this.accountKey
    return this.keys.get(vaultId) ?? null
  }

  has(vaultId: string | null | undefined): boolean { return this.keyFor(vaultId) !== null }
}
