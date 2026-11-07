// Backups for self-hosted installs: one encrypted file holds everything needed
// to rebuild the server — every row of the table and the two server secrets —
// so a backup and its passphrase are a complete restore, onto any driver.
//
// File layout:
//
//   VAULTBACKUP1\n
//   <header JSON>\n          format, version, time, schema, row count, KDF, IV
//   <ciphertext><16-byte tag> AES-256-GCM of gzip(JSON {secrets, rows});
//                             the header line is the additional data, so it
//                             cannot be altered without failing to decrypt
//
// The key is scrypt(passphrase, salt). The rows are already ciphertext the
// server cannot read; the passphrase protects the server secrets beside them
// (without SERVER_PEPPER nobody can sign in) and the structure of the data.
// Rate-limit counters are left out; they mean nothing on another server.

import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gunzipSync, gzipSync } from 'node:zlib'

import type { Config } from './config.js'
import { BACKUP_SK, SYSTEM_PK } from './keys.js'
import { s3Put } from './s3.js'
import { LATEST_VERSION } from './storage/migrations.js'
import type { Item, ManagedStore } from './store.js'

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>
const MAGIC = 'VAULTBACKUP1\n'
const KDF = { algorithm: 'scrypt', N: 65536, r: 8, p: 1 } as const
export const MIN_PASSPHRASE = 16

export interface BackupHeader {
  format: 'vault-backup'
  version: 1
  createdAt: string
  schemaVersion: number
  rows: number
  kdf: { algorithm: 'scrypt'; N: number; r: number; p: number; salt: string }
  iv: string
}

export interface BackupContents {
  secrets: { SERVER_PEPPER: string; TOKEN_SIGNING_KEY: string }
  rows: Item[]
}

const deriveKey = (passphrase: string, salt: Buffer, k: { N: number; r: number; p: number }) =>
  scrypt(passphrase, salt, 32, { N: k.N, r: k.r, p: k.p, maxmem: 256 * 1024 * 1024 })

export async function sealBackup(contents: BackupContents, passphrase: string, schemaVersion = LATEST_VERSION, now = new Date()): Promise<Buffer> {
  if (passphrase.length < MIN_PASSPHRASE) throw new Error(`BACKUP_PASSPHRASE must be at least ${MIN_PASSPHRASE} characters`)
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const header: BackupHeader = {
    format: 'vault-backup', version: 1, createdAt: now.toISOString(), schemaVersion, rows: contents.rows.length,
    kdf: { ...KDF, salt: salt.toString('base64') }, iv: iv.toString('base64'),
  }
  const headerLine = JSON.stringify(header)
  const key = await deriveKey(passphrase, salt, KDF)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(headerLine))
  const body = Buffer.concat([cipher.update(gzipSync(JSON.stringify(contents))), cipher.final(), cipher.getAuthTag()])
  return Buffer.concat([Buffer.from(MAGIC + headerLine + '\n'), body])
}

export function readHeader(file: Buffer): { header: BackupHeader; headerLine: string; body: Buffer } {
  if (file.subarray(0, MAGIC.length).toString() !== MAGIC) throw new Error('not a Vault backup file')
  const end = file.indexOf(0x0a, MAGIC.length)
  if (end < 0) throw new Error('the backup file is truncated')
  const headerLine = file.subarray(MAGIC.length, end).toString()
  const header = JSON.parse(headerLine) as BackupHeader
  if (header.format !== 'vault-backup' || header.version !== 1) throw new Error('unsupported backup format')
  return { header, headerLine, body: file.subarray(end + 1) }
}

export async function openBackup(file: Buffer, passphrase: string): Promise<{ header: BackupHeader; contents: BackupContents }> {
  const { header, headerLine, body } = readHeader(file)
  const k = header.kdf
  if (k.algorithm !== 'scrypt' || k.N < 16384 || k.N > 1 << 20) throw new Error('unsupported key derivation in the backup header')
  const key = await deriveKey(passphrase, Buffer.from(k.salt, 'base64'), k)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'))
  decipher.setAAD(Buffer.from(headerLine))
  decipher.setAuthTag(body.subarray(body.length - 16))
  let plain: Buffer
  try {
    plain = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()])
  } catch {
    throw new Error('wrong passphrase, or the backup file has been changed or damaged')
  }
  return { header, contents: JSON.parse(gunzipSync(plain).toString()) as BackupContents }
}

export const backupsEnabled = (c: Config) => !!c.backup.passphrase && (!!c.backup.dir || !!c.backup.s3)

/** Takes one backup: reads every row, seals, writes to disk and/or S3,
 *  prunes old local files, and records it for the admin panel. */
export async function runBackup(store: ManagedStore, config: Config, now = new Date()): Promise<{ name: string; bytes: number; rows: number }> {
  const b = config.backup
  if (!b.passphrase) throw new Error('BACKUP_PASSPHRASE is not set')
  if (!b.dir && !b.s3) throw new Error('set BACKUP_DIR or the BACKUP_S3_* settings')
  // Not rate counters (meaningless elsewhere), and not the record of the last
  // backup (a restored server has not taken one yet).
  const rows = (await store.scan()).filter((r) => !r.pk.startsWith('RATE#') && !(r.pk === SYSTEM_PK && r.sk === BACKUP_SK))
  const file = await sealBackup({ secrets: { SERVER_PEPPER: config.pepper, TOKEN_SIGNING_KEY: config.tokenKey }, rows }, b.passphrase, LATEST_VERSION, now)
  const name = `vault-${now.toISOString().replace(/[:.]/g, '-')}.vbk`

  if (b.dir) {
    mkdirSync(b.dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(b.dir, name), file, { mode: 0o600, flag: 'wx' })
    const old = readdirSync(b.dir).filter((f) => /^vault-.*\.vbk$/.test(f)).sort().reverse().slice(b.keep)
    for (const f of old) rmSync(join(b.dir, f))
  }
  if (b.s3) await s3Put(b.s3, `${b.s3.prefix}${name}`, file, 'application/octet-stream')

  await store.put({ pk: SYSTEM_PK, sk: BACKUP_SK, at: now.toISOString(), object: name, bytes: file.length })
  return { name, bytes: file.length, rows: rows.length }
}

/** Restores a backup into an empty database. Returns the secrets the server
 *  must run with afterwards — the caller writes them where config reads them. */
export async function restoreBackup(store: ManagedStore, file: Buffer, passphrase: string, opts: { force?: boolean } = {}): Promise<{ header: BackupHeader; secrets: BackupContents['secrets'] }> {
  const { header, contents } = await openBackup(file, passphrase)
  if (header.schemaVersion > LATEST_VERSION) throw new Error(`the backup is from a newer server (schema ${header.schemaVersion}); restore it with that release or later`)
  const existing = await store.scan()
  if (existing.length && !opts.force) throw new Error(`the database is not empty (${existing.length} rows); restore into a new one, or pass --force to replace everything`)
  for (const r of existing) await store.delete(r.pk, r.sk)
  for (const row of contents.rows) await store.put(row, { mustNotExist: true })
  return { header, secrets: contents.secrets }
}
