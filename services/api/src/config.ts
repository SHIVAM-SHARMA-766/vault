// Runtime configuration.
//
// The database password and the two server secrets are read from the
// environment, which systemd populates from a root-owned file on the host.
// They are deliberately not passed through instance metadata, which anything
// running on the host can read. A value passed
// through Terraform ends up in the state file in plaintext, and the state file
// gets copied to laptops and CI runners; a value committed to the repository
// needs no explanation at all.
//
// See docs/runbook.md for generating and installing them.

export interface Config {
  region: string
  bucket: string
  namespace: string
  db: {
    host: string
    user: string
    password: string
    database: string
    port: number
  }
  /** HMAC key for email digests and decoy salts. */
  pepper: string
  /** HMAC key for access and refresh tokens. */
  tokenKey: string
}

let cached: Config | null = null

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`missing environment variable: ${name}`)
  return value
}

/** Refuses to start rather than running with a weak or placeholder secret. A
 *  service that comes up with a guessable pepper is worse than one that does
 *  not come up at all, because nothing about it looks wrong. */
function requiredSecret(name: string): string {
  const value = required(name)
  if (value.length < 32) {
    throw new Error(`${name} is too short; generate one with: openssl rand -base64 32`)
  }
  if (/^(placeholder|changeme|test|secret)/i.test(value)) {
    throw new Error(`${name} still holds a placeholder value`)
  }
  return value
}

export function loadConfig(): Config {
  if (cached) return cached
  cached = {
    region: process.env['OCI_REGION'] ?? 'ap-mumbai-1',
    bucket: process.env['BACKUP_BUCKET'] ?? '',
    namespace: process.env['OBJECTSTORAGE_NAMESPACE'] ?? '',
    db: {
      host: required('DB_HOST'),
      user: process.env['DB_USER'] ?? 'vault',
      password: required('DB_PASSWORD'),
      database: process.env['DB_NAME'] ?? 'vault',
      port: Number(process.env['DB_PORT'] ?? 3306),
    },
    pepper: requiredSecret('SERVER_PEPPER'),
    tokenKey: requiredSecret('TOKEN_SIGNING_KEY'),
  }
  return cached
}

/** Tests only. */
export function setConfigForTesting(config: Config | null): void {
  cached = config
}
