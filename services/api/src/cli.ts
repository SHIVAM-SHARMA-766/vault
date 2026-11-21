// Commands run against the server's own configuration, without starting it:
//
//   node index.mjs backup                     take a backup now
//   node index.mjs restore <file> [--force]   restore a backup into this server's database
//   node index.mjs reset-two-factor <email>   turn off an account's two-factor sign-in
//                                             (the only admin of a personal Vault has nobody else to ask)
//
// In a container:  docker compose run --rm vault node index.mjs backup
// Restore with the server stopped (docker compose stop vault), then start it.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { restoreBackup, runBackup } from './backup.js'
import { loadConfig } from './config.js'
import { openStore } from './storage/index.js'

export async function backupCommand(): Promise<void> {
  const config = loadConfig()
  const store = await openStore(config)
  try {
    await store.migrate()
    const r = await runBackup(store, config)
    console.log(`backup written: ${r.name} (${r.rows} rows, ${r.bytes} bytes)${config.backup.dir ? ` to ${config.backup.dir}` : ''}${config.backup.s3 ? ` and s3://${config.backup.s3.bucket}/${config.backup.s3.prefix}` : ''}`)
  } finally {
    await store.close()
  }
}

export async function resetTwoFactorCommand(args: string[]): Promise<void> {
  const email = args[0]
  if (!email) throw new Error('usage: reset-two-factor <email>')
  const { buildApp } = await import('./server.js')
  const { resetTwoFactorFromHost } = await import('./routes/admin.js')
  const { app, store } = await buildApp()
  try {
    await store.migrate()
    await resetTwoFactorFromHost(app, email)
    console.log(`two-factor sign-in is off for ${email}. Sign in with the master password, then turn it on again under Settings → Security.`)
  } finally {
    await store.close()
  }
}

export async function restoreCommand(args: string[]): Promise<void> {
  const path = args.find((a) => !a.startsWith('--'))
  if (!path) throw new Error('usage: restore <backup file> [--force]')
  const config = loadConfig()
  const passphrase = process.env['BACKUP_PASSPHRASE'] ?? config.backup.passphrase
  if (!passphrase) throw new Error('set BACKUP_PASSPHRASE to the passphrase the backup was taken with')
  const store = await openStore(config)
  try {
    await store.migrate()
    const { header, secrets } = await restoreBackup(store, readFileSync(path), passphrase, { force: args.includes('--force') })
    // The restored accounts only work with the secrets they were created
    // under. Put them where this server reads its secrets.
    const target = process.env['SECRETS_FILE'] || join(dirname(path), 'restored-secrets.env')
    if (existsSync(target)) renameSync(target, `${target}.before-restore-${Date.now()}`)
    writeFileSync(target, `# Restored from a backup taken ${header.createdAt}.\nSERVER_PEPPER=${secrets.SERVER_PEPPER}\nTOKEN_SIGNING_KEY=${secrets.TOKEN_SIGNING_KEY}\n`, { mode: 0o600 })
    console.log(`restored ${header.rows} rows from a backup taken ${header.createdAt}.`)
    console.log(process.env['SECRETS_FILE']
      ? `server secrets restored to ${target}. Start the server.`
      : `server secrets written to ${target}: set them in the server's environment before starting it.`)
  } finally {
    await store.close()
  }
}
