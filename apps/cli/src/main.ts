#!/usr/bin/env node
// vault: secrets from your Vault on the command line, decrypted on this
// machine only (admin console phase 5).
//
//   vault login --server https://vault.example.com --email you@example.com
//   vault list [search]
//   vault read vault://GitHub/password
//   vault run --env-file .env.vault -- npm start
//   vault logout
//
// The master password is asked each time, or read from VAULT_MASTER_PASSWORD
// (for CI); VAULT_SECRET_KEY for accounts with a secret key. Nothing
// decrypted is written to disk.

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

import { ApiError, loadConfig, login, logout, saveConfig, unlock } from './client.js'
import { type Item, fieldOf, findItem, parseEnvTemplate, parseRef, refsIn, substitute } from './refs.js'

const HELP = `vault — your Vault on the command line, decrypted on this machine only.

  vault login --server <url> --email <address>   sign in to your account (once)
  vault list [search]                            item names (no secrets)
  vault read <vault://item/field>                print one secret
  vault run [--env-file <file>] -- <command>     run a command with secrets in its environment
  vault logout                                   forget the sign-in on this machine

A reference is vault://<item name>/<field>. Fields: password, username, url,
notes, totp, fields.<name>, or a custom field's label.

Environment: VAULT_MASTER_PASSWORD, VAULT_SECRET_KEY (if your account has one),
VAULT_CLI_CONFIG (where the sign-in is kept).`

/** Asks a question on the terminal; hidden for passwords. */
function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) return reject(new Error(`${question.trim()} needs a terminal; set it in the environment instead.`))
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true })
    if (hidden) {
      const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream }
      out._writeToOutput = (s: string) => { if (s.includes(question)) out.output.write(question) }
    }
    rl.question(question, (answer) => { rl.close(); if (hidden) process.stderr.write('\n'); resolve(answer) })
  })
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

async function open() {
  const config = loadConfig()
  if (!config?.accountToken) throw new Error('Not signed in. Run `vault login --server <url> --email <address>` first.')
  const password = process.env['VAULT_MASTER_PASSWORD'] ?? await ask('Master password: ', true)
  return unlock(config, password, process.env['VAULT_SECRET_KEY'])
}

async function resolver(items: Item[], totp: (s: string) => Promise<string>) {
  return async (ref: string) => {
    const { item, field } = parseRef(ref)
    const it = findItem(items, item)
    if (field.toLowerCase() === 'totp') {
      if (!it.totpSecret) throw new Error(`"${it.name}" has no one-time code.`)
      return totp(it.totpSecret)
    }
    return fieldOf(it, field)
  }
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv
  switch (cmd) {
    case 'login': {
      const server = flag(args, '--server') ?? loadConfig()?.server ?? await ask('Server (https://…): ')
      const email = (flag(args, '--email') ?? await ask('Email: ')).trim().toLowerCase()
      if (!/^https:\/\/|^http:\/\/localhost[:/]|^http:\/\/127\.0\.0\.1[:/]/.test(server)) throw new Error('The server must be an https:// address (http only for localhost).')
      const accountPassword = process.env['VAULT_ACCOUNT_PASSWORD'] ?? await ask('Account password: ', true)
      const config = await login(server, email, accountPassword, () => ask('Two-factor code (or a recovery code): ', true))
      saveConfig(config)
      process.stderr.write(`Signed in as ${email}. The master password is asked when a secret is needed.\n`)
      return 0
    }
    case 'logout': {
      const c = loadConfig()
      if (c?.accountToken) await logout(c)
      saveConfig(null)
      process.stderr.write('Signed out on this machine.\n')
      return 0
    }
    case 'list': {
      const v = await open()
      try {
        const q = args.join(' ').toLowerCase()
        for (const it of v.items.filter((i) => !q || i.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name))) {
          process.stdout.write(`${it.name}${it.username ? `\t${it.username}` : ''}\n`)
        }
      } finally { await v.done() }
      return 0
    }
    case 'read': {
      if (!args[0]) throw new Error('Usage: vault read vault://<item>/<field>')
      const v = await open()
      try {
        const value = await (await resolver(v.items, v.totp))(args.join(' '))
        process.stdout.write(process.stdout.isTTY ? `${value}\n` : value)
      } finally { await v.done() }
      return 0
    }
    case 'run': {
      const sep = args.indexOf('--')
      if (sep < 0 || sep === args.length - 1) throw new Error('Usage: vault run [--env-file <file>] -- <command> [args…]')
      const file = flag(args.slice(0, sep), '--env-file')
      const pairs: [string, string][] = file ? parseEnvTemplate(readFileSync(file, 'utf8')) : []
      // The current environment's references are resolved too.
      for (const [k, val] of Object.entries(process.env)) if (val && refsIn(val).length && !pairs.some(([p]) => p === k)) pairs.push([k, val])
      const env: NodeJS.ProcessEnv = { ...process.env }
      delete env['VAULT_MASTER_PASSWORD']; delete env['VAULT_SECRET_KEY']; delete env['VAULT_ACCOUNT_PASSWORD']
      if (pairs.some(([, val]) => refsIn(val).length)) {
        const v = await open()
        try {
          const resolve = await resolver(v.items, v.totp)
          for (const [k, val] of pairs) env[k] = await substitute(val, resolve)
        } finally { await v.done() }
      } else {
        for (const [k, val] of pairs) env[k] = val
      }
      const [command, ...rest] = args.slice(sep + 1)
      return new Promise((resolve) => {
        const child = spawn(command!, rest, { stdio: 'inherit', env })
        child.on('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1)))
        child.on('error', (err) => { process.stderr.write(`vault: ${err.message}\n`); resolve(127) })
      })
    }
    case undefined: case 'help': case '--help': case '-h':
      process.stdout.write(`${HELP}\n`)
      return 0
    default:
      process.stderr.write(`vault: unknown command "${cmd}".\n\n${HELP}\n`)
      return 2
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code), (err: unknown) => {
  const msg = err instanceof ApiError || err instanceof Error ? err.message : String(err)
  process.stderr.write(`vault: ${msg}\n`)
  process.exit(1)
})
