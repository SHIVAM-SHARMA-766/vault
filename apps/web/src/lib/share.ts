// Share links (D3, decisions/0018). A fresh 32-byte key seals one item; the
// key goes only into the link's #fragment, which the browser never sends to
// any server. The link id is bound into the ciphertext as associated data,
// so a server that swapped two links' blobs would produce a failure, not the
// wrong item.

import { fromBase64Url, randomBytes, sealJson, toBase64Url, unsealJson, utf8Encode } from '@vault/crypto'
import type { EntryContent } from '@vault/crypto'

/** What a link carries: the item as its owner sees it, without where it sits
 *  in their vault (folder, tags, favourite, archive). */
export type SharedItem = Pick<EntryContent, 'name' | 'type' | 'username' | 'password' | 'url' | 'notes' | 'totpSecret' | 'customFields' | 'fields'>

interface Payload { v: 1; item: SharedItem; sharedAt: string }

const aad = (id: string) => utf8Encode(`vault.share.v1:${id}`)
const labelAad = (id: string) => utf8Encode(`vault.share-label.v1:${id}`)

export function toShared(e: EntryContent): SharedItem {
  const out: SharedItem = { name: e.name, type: e.type, customFields: e.customFields ?? [] }
  for (const k of ['username', 'password', 'url', 'notes', 'totpSecret'] as const) if (e[k]) out[k] = e[k]
  if (e.fields && Object.keys(e.fields).length) out.fields = e.fields
  return out
}

/** Seals an item for a new link. `vaultKey` seals only the name, for the
 *  owner's own list of links. */
export async function sealShare(item: SharedItem, vaultKey: Uint8Array) {
  const id = toBase64Url(randomBytes(16))
  const key = randomBytes(32)
  const blob = await sealJson<Payload>(key, { v: 1, item, sharedAt: new Date().toISOString() }, aad(id))
  const labelBlob = await sealJson(vaultKey, { name: item.name }, labelAad(id))
  return { id, key: toBase64Url(key), blob, labelBlob }
}

export function linkFor(id: string, key: string, origin = location.origin): string {
  return `${origin}/app/s/${id}#${key}`
}

/** The id and key from a link's address, or null if either is missing. */
export function parseLink(pathname: string, hash: string): { id: string; key: string } | null {
  const id = /^\/app\/s\/([A-Za-z0-9_-]{22})\/?$/.exec(pathname)?.[1]
  const key = hash.replace(/^#/, '')
  return id && /^[A-Za-z0-9_-]{43}$/.test(key) ? { id, key } : null
}

export async function openShareBlob(id: string, key: string, blob: string): Promise<{ item: SharedItem; sharedAt: string }> {
  const p = await unsealJson<Payload>(fromBase64Url(key), blob, aad(id))
  return { item: p.item, sharedAt: p.sharedAt }
}

export async function openLabel(id: string, labelBlob: string, vaultKey: Uint8Array): Promise<string> {
  try { return (await unsealJson<{ name: string }>(vaultKey, labelBlob, labelAad(id))).name } catch { return 'An item' }
}
