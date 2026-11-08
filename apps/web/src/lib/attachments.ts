// File attachments (D2, decisions/0020): each file is sealed in this browser
// with a fresh 32-byte key and uploaded; the key and the file's name, type and
// size go into the entry, which is sealed with the vault key as always.

import { type AttachmentRef, fromBase64Url, randomBytes, seal, toBase64Url, unseal, utf8Encode } from '@vault/crypto'

import { api } from './api.js'
import * as session from './session.js'

/** Per file, before encryption. */
export const ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024

const aad = (id: string) => utf8Encode(`vault.attachment.v1:${id}`)

export async function uploadAttachment(file: File): Promise<AttachmentRef> {
  if (file.size > ATTACHMENT_MAX_BYTES) throw new Error(`${file.name} is larger than 2 MB. Attach a smaller file.`)
  const id = crypto.randomUUID()
  const key = randomBytes(32)
  const blob = await seal(key, new Uint8Array(await file.arrayBuffer()), aad(id))
  await api.attachments.put(await session.token(), id, blob)
  return { id, name: file.name.slice(0, 200), type: (file.type || 'application/octet-stream').slice(0, 100), size: file.size, key: toBase64Url(key) }
}

export async function openAttachment(ref: AttachmentRef): Promise<Uint8Array> {
  const { blob } = await api.attachments.get(await session.token(), ref.id)
  return unseal(fromBase64Url(ref.key), blob, aad(ref.id))
}

export async function saveAttachment(ref: AttachmentRef): Promise<void> {
  const bytes = await openAttachment(ref)
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: ref.type }))
  const a = document.createElement('a')
  a.href = url
  a.download = ref.name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Deletes files no longer referenced; best effort (a leftover is ciphertext
 *  nobody holds a key to, counted against the quota until deleted). */
export async function deleteAttachments(ids: string[]): Promise<void> {
  const token = await session.token()
  await Promise.all(ids.map((id) => api.attachments.remove(token, id).catch(() => {})))
}

export const describeSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
