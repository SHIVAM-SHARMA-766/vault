// Encrypted exports: the whole vault, in a file only its export password opens.
//
// The export password is chosen when exporting, and is deliberately separate
// from the master password: a file that leaves the vault may be stored or
// sent somewhere the account is not, and should not be one guess away from
// the account itself. It goes through the same 600,000 rounds of PBKDF2, then
// an HKDF branch of its own, and the payload is sealed with AES-256-GCM under
// an AAD naming the format.
//
//   { "format": "vault-export", "version": 1,
//     "kdf": { "algorithm": "PBKDF2-HMAC-SHA256", "iterations": 600000, "salt": "…" },
//     "data": "v1.<iv>.<ciphertext>" }

import { UnsealError, sealJson, unsealJson } from './aead.js'
import { fromBase64Url, toBase64Url, utf8Encode, wipe } from './encoding.js'
import { KEY_BYTES, PBKDF2_ITERATIONS, deriveMasterKey, generateSalt } from './keys.js'
import { hkdfSha256 } from './primitives.js'

export const EXPORT_FORMAT = 'vault-export'
export const EXPORT_VERSION = 1
const AAD_EXPORT = utf8Encode('vault.export.v1')
const INFO_EXPORT = utf8Encode('vault.export.key.v1')

export interface ExportFile {
  format: typeof EXPORT_FORMAT
  version: number
  kdf: { algorithm: 'PBKDF2-HMAC-SHA256'; iterations: number; salt: string }
  data: string
}

async function exportKey(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const stretched = await deriveMasterKey(password, salt, iterations)
  try {
    return await hkdfSha256(stretched, new Uint8Array(0), INFO_EXPORT, KEY_BYTES)
  } finally {
    wipe(stretched)
  }
}

export async function sealExport<T>(password: string, payload: T, iterations: number = PBKDF2_ITERATIONS): Promise<string> {
  const salt = generateSalt()
  const key = await exportKey(password, salt, iterations)
  try {
    const file: ExportFile = {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      kdf: { algorithm: 'PBKDF2-HMAC-SHA256', iterations, salt: toBase64Url(salt) },
      data: await sealJson(key, payload, AAD_EXPORT),
    }
    return JSON.stringify(file, null, 2)
  } finally {
    wipe(key)
  }
}

export function isExportFile(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as Partial<ExportFile>
    return parsed.format === EXPORT_FORMAT && typeof parsed.data === 'string'
  } catch {
    return false
  }
}

/** Opens an export. A wrong password and a damaged file both raise
 *  UnsealError; neither says which. */
export async function openExport<T>(password: string, text: string): Promise<T> {
  let file: ExportFile
  try {
    file = JSON.parse(text) as ExportFile
  } catch {
    throw new UnsealError('not an export file')
  }
  if (file.format !== EXPORT_FORMAT) throw new UnsealError('not an export file')
  if (file.version !== EXPORT_VERSION) throw new UnsealError(`unsupported export version: ${file.version}`)
  if (!Number.isInteger(file.kdf?.iterations) || file.kdf.iterations < 100_000 || file.kdf.iterations > 10_000_000) {
    throw new UnsealError('implausible key derivation parameters')
  }
  const key = await exportKey(password, fromBase64Url(file.kdf.salt), file.kdf.iterations)
  try {
    return await unsealJson<T>(key, file.data, AAD_EXPORT)
  } finally {
    wipe(key)
  }
}
