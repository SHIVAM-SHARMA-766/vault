// Entry point. With no arguments it starts the server; `backup` and `restore`
// are the operator commands in cli.ts.
import { backupCommand, resetTwoFactorCommand, restoreCommand } from './cli.js'
import { start } from './server.js'

const [command, ...args] = process.argv.slice(2)

const run = command === 'backup' ? backupCommand()
  : command === 'restore' ? restoreCommand(args)
  : command === 'reset-two-factor' ? resetTwoFactorCommand(args)
  : command ? Promise.reject(new Error(`unknown command "${command}"; use backup, restore or reset-two-factor`))
  : start()

run.catch((err: unknown) => {
  // Refusing to start is the correct answer to a missing secret or an
  // unreachable database. Exiting non-zero is what tells systemd to retry.
  console.error(command ? `${command} failed:` : 'failed to start:', err instanceof Error ? err.message : err)
  process.exit(1)
})
