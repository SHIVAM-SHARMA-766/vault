// Entry and folder content. An entry is sealed as a single JSON blob rather
// than field by field, because every field is secret — including the name, the
// tags, and which folder it belongs to. The server stores an opaque identifier,
// one ciphertext, and two timestamps.
//
// The identifier is bound into the ciphertext as additional authenticated data.
// A server that swapped two entries' blobs, or replayed an old blob under a new
// id, would produce a tag failure rather than a silently wrong entry.

import { sealJson, unsealJson } from './aead.js'
import { utf8Encode } from './encoding.js'

export type EntryType =
  | 'login'
  | 'note'
  | 'card'
  | 'identity'
  | 'bankAccount'
  | 'sshKey'
  | 'wifi'

export interface CustomField {
  label: string
  value: string
  /** Render masked until the user reveals it. Presentation only — it has no
   *  bearing on how the value is stored, which is encrypted either way. */
  hidden: boolean
}

/** Everything the user typed. Sealed as one blob; the server sees none of it. */
export interface EntryContent {
  name: string
  type: EntryType
  username?: string
  password?: string
  url?: string
  notes?: string
  tags: string[]
  /** Base32, RFC 4648 — the format authenticator apps emit. */
  totpSecret?: string
  customFields: CustomField[]
  /** The fields particular to the entry's type — a card's number and expiry,
   *  an SSH key's private half — keyed as packages/core's item model names
   *  them. Absent on entries saved before types had their own fields. */
  fields?: Record<string, string>
  favorite: boolean
  /** Out of sight but kept: left out of lists, counts, search and the health
   *  check until restored. Inside the blob, so the server cannot tell. */
  archived?: boolean
  /** Which folder this belongs to. Inside the blob rather than beside it, so
   *  the organisation of the vault is hidden along with its contents. */
  folderId?: string
  icon?: string
  iconColor?: string
  /** When the password last changed (ISO 8601), for the health check's "old"
   *  finding. Set by the client on save; absent on older entries. */
  passwordChangedAt?: string
}

export interface FolderContent {
  name: string
  parentId?: string
}

/** An entry as the server holds it: an id it cannot interpret, a blob it cannot
 *  read, and timestamps it maintains. */
export interface SealedEntry {
  id: string
  blob: string
  createdAt: string
  updatedAt: string
}

export interface SealedFolder {
  id: string
  blob: string
  createdAt: string
  updatedAt: string
}

const entryAad = (id: string): Uint8Array => utf8Encode(`vault.entry.v1:${id}`)
const folderAad = (id: string): Uint8Array => utf8Encode(`vault.folder.v1:${id}`)
// A previous version of an entry. Its own AAD, so the server cannot present a
// history snapshot as the live entry or move it to another entry's history.
const historyAad = (entryId: string): Uint8Array => utf8Encode(`vault.history.v1:${entryId}`)

export async function sealEntry(
  id: string,
  content: EntryContent,
  vaultKey: Uint8Array,
): Promise<string> {
  return sealJson(vaultKey, content, entryAad(id))
}

export async function openEntry(
  id: string,
  blob: string,
  vaultKey: Uint8Array,
): Promise<EntryContent> {
  return unsealJson<EntryContent>(vaultKey, blob, entryAad(id))
}

export async function sealFolder(
  id: string,
  content: FolderContent,
  vaultKey: Uint8Array,
): Promise<string> {
  return sealJson(vaultKey, content, folderAad(id))
}

export async function openFolder(
  id: string,
  blob: string,
  vaultKey: Uint8Array,
): Promise<FolderContent> {
  return unsealJson<FolderContent>(vaultKey, blob, folderAad(id))
}

/** Seals a previous version of an entry for its history. */
export async function sealHistory(
  entryId: string,
  content: EntryContent,
  vaultKey: Uint8Array,
): Promise<string> {
  return sealJson(vaultKey, content, historyAad(entryId))
}

export async function openHistory(
  entryId: string,
  blob: string,
  vaultKey: Uint8Array,
): Promise<EntryContent> {
  return unsealJson<EntryContent>(vaultKey, blob, historyAad(entryId))
}

/** DynamoDB rejects any item over 400 KB, and a rejected write surfaces as a
 *  failed save after the user has already typed everything. Checking before the
 *  request turns that into a message they can act on. The margin covers the
 *  item's keys, timestamps, and attribute names. */
export const MAX_BLOB_BYTES = 380 * 1024

export function isWithinSizeLimit(blob: string): boolean {
  return utf8Encode(blob).length <= MAX_BLOB_BYTES
}
