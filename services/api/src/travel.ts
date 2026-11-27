// Travel mode: while it is on, the vaults not marked safe for travel are not
// served to any device of the account — not to the web app, the extension,
// the CLI or a new offline copy — and cannot be written to. They are not
// deleted; turning travel mode off brings them back. Turning it off, or
// marking another vault safe while it is on, needs the master password again
// (the sudo window), so a device that is merely signed in cannot undo it.
//
// The server keeps one row per account: whether travel mode is on, and which
// vaults are safe ('personal' for the account's own vault).

import type { App } from './context.js'
import { type LambdaEvent, type LambdaResponse, badRequest, json, parseJsonBody } from './http.js'
import { VAULT_PREFIX, isValidId, userPk } from './keys.js'
import { requireSudo } from './sudo.js'

export const TRAVEL_SK = 'TRAVEL'
export const PERSONAL_VAULT = 'personal'

export interface Travel { on: boolean; safe: Set<string> }

export async function getTravel(app: App, userId: string): Promise<Travel> {
  const row = await app.store.get(userPk(userId), TRAVEL_SK)
  const safe = Array.isArray(row?.['safe']) ? (row!['safe'] as unknown[]).filter((x): x is string => typeof x === 'string') : []
  return { on: row?.['on'] === true, safe: new Set(safe) }
}

/** Whether a vault (null for Personal) is served right now. */
export const isServed = (t: Travel, vaultId: string | null | undefined): boolean =>
  !t.on || t.safe.has(vaultId ? vaultId : PERSONAL_VAULT)

export const travelView = (t: Travel) => ({ on: t.on, safe: [...t.safe].sort() })

/** GET /api/vault/travel */
export async function readTravel(app: App, userId: string): Promise<LambdaResponse> {
  return json(200, travelView(await getTravel(app, userId)))
}

/** PUT /api/vault/travel: { on, safe }. */
export async function writeTravel(app: App, userId: string, event: LambdaEvent): Promise<LambdaResponse> {
  const body = parseJsonBody<{ on?: unknown; safe?: unknown }>(event)
  const now = await getTravel(app, userId)
  const on = typeof body.on === 'boolean' ? body.on : now.on
  let safe = now.safe
  if (body.safe !== undefined) {
    if (!Array.isArray(body.safe) || body.safe.length > 64) throw badRequest('safe must be a list of vault ids.')
    const own = new Set((await app.store.query(userPk(userId), VAULT_PREFIX)).map((v) => String(v['id'])))
    safe = new Set()
    for (const id of body.safe) {
      if (id === PERSONAL_VAULT || (isValidId(id) && own.has(id))) safe.add(id)
      else throw badRequest('safe names a vault that is not yours.')
    }
  }
  // Anything that brings a hidden vault back needs the password again.
  const reveals = now.on && (!on || [...safe].some((id) => !now.safe.has(id)))
  if (reveals) await requireSudo(app, event)
  await app.store.put({ pk: userPk(userId), sk: TRAVEL_SK, on, safe: [...safe], updatedAt: new Date(app.now()).toISOString() })
  return json(200, travelView({ on, safe }))
}
