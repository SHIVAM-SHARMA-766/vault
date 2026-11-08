// Deleting your own account (Settings → Account). Proof of the master
// password, and the second factor when it is on, because this cannot be
// undone; refused while the account owns organizations (they would be left
// without an owner) or is the server's only owner.

import type { App } from '../context.js'
import { HttpError, type LambdaEvent, type LambdaResponse, badRequest, json, parseJsonBody } from '../http.js'
import { roleFromDigest } from '../roles.js'
import { audit, listRegistry } from '../system.js'
import { eraseAccount } from './admin.js'
import { profileWithPassword, requireSecondFactor } from './auth.js'
import { leaveAllOrgs } from './orgs.js'

export const DELETE_CONFIRMATION = 'DELETE'

export async function deleteOwnAccount(app: App, userId: string, event: LambdaEvent): Promise<LambdaResponse> {
  const body = parseJsonBody<Record<string, unknown>>(event)
  if (body['confirm'] !== DELETE_CONFIRMATION) throw badRequest(`Type ${DELETE_CONFIRMATION} to confirm.`)
  const profile = await profileWithPassword(app, userId, body)
  if (profile.totp) await requireSecondFactor(app, profile, body, event)

  const { owned } = await leaveAllOrgs(app, userId, true)
  if (owned.length) {
    throw new HttpError(409, 'conflict', `You own ${owned.length === 1 ? 'an organization' : `${owned.length} organizations`}. Make someone else the owner, or delete ${owned.length === 1 ? 'it' : 'them'}, under Organizations first.`)
  }
  const registry = await listRegistry(app)
  const role = (digest: string, stored: unknown) => roleFromDigest(app, digest, stored)
  const me = registry.find((r) => r.userId === userId)
  if (me && role(me.emailDigest, me['role']) === 'owner') {
    const owners = registry.filter((r) => role(r.emailDigest, r['role']) === 'owner')
    if (owners.length <= 1) throw new HttpError(409, 'conflict', 'You are the only owner of this server. Make someone else an owner in the admin panel first, so the server is not left without one.')
  }

  await audit(app, userId, 'user.self-delete', userId)
  await eraseAccount(app, userId, profile.emailDigest)
  return json(200, { ok: true })
}
