// Sharing inside an organization (decisions/0009, 0015).
//
//   org key         random, one per organization; sealed to every confirmed
//                   member; encrypts organization-level names (the org's own
//                   name, collection names) so the server cannot read them
//   collection key  random, one per collection and key version; sealed to each
//                   member granted access; encrypts the collection's items
//
// Every sealed copy names what it is for — the context passed to
// sealForRecipient, or the AAD of a symmetric seal — so the server cannot
// present one thing as another: a key for collection A as a key for B, an
// item of collection A as an item of B, or an old key version as a new one.

import { sealJson, unsealJson } from './aead.js'
import { utf8Encode } from './encoding.js'
import type { EntryContent } from './entry.js'
import { openFromSender, sealForRecipient } from './identity.js'
import { randomBytes } from './random.js'

export const SHARED_KEY_BYTES = 32

export const generateOrgKey = (): Uint8Array => randomBytes(SHARED_KEY_BYTES)
export const generateCollectionKey = (): Uint8Array => randomBytes(SHARED_KEY_BYTES)

const orgKeyContext = (orgId: string) => `org-key:${orgId}`
const collectionKeyContext = (collectionId: string, version: number) => `collection-key:${collectionId}:v${version}`

/** The org key, for one member. */
export const sealOrgKey = (memberPublicKey: Uint8Array, orgKey: Uint8Array, orgId: string): Promise<string> =>
  sealForRecipient(memberPublicKey, orgKey, orgKeyContext(orgId))

export const openOrgKey = (privateKey: Uint8Array, ownPublicKey: Uint8Array, blob: string, orgId: string): Promise<Uint8Array> =>
  openFromSender(privateKey, ownPublicKey, blob, orgKeyContext(orgId))

/** A collection key at one version, for one member. */
export const sealCollectionKey = (memberPublicKey: Uint8Array, key: Uint8Array, collectionId: string, version: number): Promise<string> =>
  sealForRecipient(memberPublicKey, key, collectionKeyContext(collectionId, version))

export const openCollectionKey = (privateKey: Uint8Array, ownPublicKey: Uint8Array, blob: string, collectionId: string, version: number): Promise<Uint8Array> =>
  openFromSender(privateKey, ownPublicKey, blob, collectionKeyContext(collectionId, version))

/** Names and other organization-level metadata, under the org key. */
export interface OrgMeta { name: string }
export interface CollectionMeta { name: string; parentId?: string }

const orgMetaAad = (orgId: string) => utf8Encode(`vault.org.v1:${orgId}`)
const collectionMetaAad = (orgId: string, collectionId: string) => utf8Encode(`vault.collection.v1:${orgId}:${collectionId}`)
const groupMetaAad = (orgId: string, groupId: string) => utf8Encode(`vault.group.v1:${orgId}:${groupId}`)
const itemAad = (collectionId: string, itemId: string, version: number) => utf8Encode(`vault.collection-item.v1:${collectionId}:${itemId}:v${version}`)

export const sealOrgMeta = (orgId: string, meta: OrgMeta, orgKey: Uint8Array) => sealJson(orgKey, meta, orgMetaAad(orgId))
export const openOrgMeta = (orgId: string, blob: string, orgKey: Uint8Array) => unsealJson<OrgMeta>(orgKey, blob, orgMetaAad(orgId))

export const sealCollectionMeta = (orgId: string, collectionId: string, meta: CollectionMeta, orgKey: Uint8Array) =>
  sealJson(orgKey, meta, collectionMetaAad(orgId, collectionId))
export const openCollectionMeta = (orgId: string, collectionId: string, blob: string, orgKey: Uint8Array) =>
  unsealJson<CollectionMeta>(orgKey, blob, collectionMetaAad(orgId, collectionId))

export interface GroupMeta { name: string }
export const sealGroupMeta = (orgId: string, groupId: string, meta: GroupMeta, orgKey: Uint8Array) => sealJson(orgKey, meta, groupMetaAad(orgId, groupId))
export const openGroupMeta = (orgId: string, groupId: string, blob: string, orgKey: Uint8Array) => unsealJson<GroupMeta>(orgKey, blob, groupMetaAad(orgId, groupId))

/** An item in a collection: the same content as a personal entry, under the
 *  collection key, bound to its collection, its id and the key version. */
export const sealSharedItem = (collectionId: string, itemId: string, version: number, content: EntryContent, key: Uint8Array) =>
  sealJson(key, content, itemAad(collectionId, itemId, version))
export const openSharedItem = (collectionId: string, itemId: string, version: number, blob: string, key: Uint8Array) =>
  unsealJson<EntryContent>(key, blob, itemAad(collectionId, itemId, version))

/** Emergency access: an account's vault key, sealed to a trusted contact's
 *  public key, bound to that emergency grant. */
export const sealEmergencyKey = (granteePublicKey: Uint8Array, vaultKey: Uint8Array, grantId: string): Promise<string> =>
  sealForRecipient(granteePublicKey, vaultKey, `emergency-access:${grantId}`)
export const openEmergencyKey = (privateKey: Uint8Array, ownPublicKey: Uint8Array, blob: string, grantId: string): Promise<Uint8Array> =>
  openFromSender(privateKey, ownPublicKey, blob, `emergency-access:${grantId}`)
