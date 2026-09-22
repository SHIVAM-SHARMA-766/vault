// Runtime configuration.
//
// The two secrets live in SSM Parameter Store, not in the function's
// environment. Environment variables are visible to anyone who can describe
// the function, which is a wider set of principals than those who can decrypt
// a SecureString — and they appear in the Terraform state that provisions it.
//
// Both are fetched once per execution environment and kept for the life of
// that container. A Lambda container serves many requests, so this is one SSM
// call per cold start rather than one per request.

import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm'

export interface Config {
  tableName: string
  region: string
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

export async function loadConfig(): Promise<Config> {
  if (cached) return cached

  const region = process.env['AWS_REGION'] ?? 'ap-south-1'
  const pepperParam = required('PEPPER_PARAM')
  const tokenKeyParam = required('TOKEN_KEY_PARAM')

  const ssm = new SSMClient({ region })
  const out = await ssm.send(
    new GetParametersCommand({ Names: [pepperParam, tokenKeyParam], WithDecryption: true }),
  )

  const values = new Map((out.Parameters ?? []).map((p) => [p.Name, p.Value]))
  const pepper = values.get(pepperParam)
  const tokenKey = values.get(tokenKeyParam)

  if (!pepper || !tokenKey) {
    throw new Error(`SSM parameters not readable: ${(out.InvalidParameters ?? []).join(', ')}`)
  }
  // Terraform creates these with a placeholder it then ignores, so that no
  // secret is ever written to the state file. Refusing to start is better than
  // running with a value an attacker could read out of a plan.
  if (pepper.startsWith('PLACEHOLDER') || tokenKey.startsWith('PLACEHOLDER')) {
    throw new Error('SSM parameters still hold their placeholder values; set them out of band')
  }

  cached = { tableName: required('TABLE_NAME'), region, pepper, tokenKey }
  return cached
}

/** Tests only. */
export function setConfigForTesting(config: Config | null): void {
  cached = config
}
