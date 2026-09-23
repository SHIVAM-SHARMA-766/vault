// Entry point. Kept to one line of logic so that nothing about starting the
// process is hidden inside a module that also does something else.
import { start } from './server.js'

start().catch((err: unknown) => {
  // Refusing to start is the correct answer to a missing secret or an
  // unreachable database. Exiting non-zero is what tells systemd to retry.
  console.error('failed to start:', err)
  process.exit(1)
})
