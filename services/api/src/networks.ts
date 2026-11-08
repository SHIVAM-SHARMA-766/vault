// The sign-in allow-list (G2): an administrator can limit where accounts sign
// in from, as addresses or CIDR ranges. Owners are exempt, so a wrong list can
// always be fixed; and a list that would shut out the admin saving it is
// refused. Checked at sign-in, recovery sign-in and every token refresh, so a
// device that leaves the network is signed out within one access-token life.

import { BlockList, isIP } from 'node:net'

import type { App } from './context.js'
import { HttpError, badRequest } from './http.js'
import { PROFILE_SK, userPk } from './keys.js'
import { roleFromDigest } from './roles.js'
import { getRegistry, getSettings } from './system.js'

export const MAX_NETWORKS = 50

/** One entry, normalised: an IPv4/IPv6 address or a CIDR range. */
export function parseNetwork(raw: string): { address: string; prefix: number; family: 'ipv4' | 'ipv6' } | null {
  const [address, bits, extra] = raw.trim().split('/')
  if (extra !== undefined || !address) return null
  const v = isIP(address)
  if (!v) return null
  const max = v === 4 ? 32 : 128
  const prefix = bits === undefined ? max : /^\d{1,3}$/.test(bits) ? Number(bits) : NaN
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null
  return { address, prefix, family: v === 4 ? 'ipv4' : 'ipv6' }
}

/** Validates an admin's list; returns it trimmed. */
export function requireNetworks(value: unknown): string[] {
  if (!Array.isArray(value)) throw badRequest('policy.allowedNetworks must be a list.')
  if (value.length > MAX_NETWORKS) throw badRequest(`policy.allowedNetworks holds at most ${MAX_NETWORKS} entries.`)
  return value.map((x, i) => {
    if (typeof x !== 'string' || !parseNetwork(x)) throw badRequest(`policy.allowedNetworks[${i}] must be an address or a CIDR range, like 203.0.113.0/24.`)
    return x.trim()
  })
}

const lists = new Map<string, BlockList>()
function listFor(networks: readonly string[]): BlockList {
  const key = networks.join(',')
  let list = lists.get(key)
  if (!list) {
    list = new BlockList()
    for (const n of networks) { const p = parseNetwork(n); if (p) list.addSubnet(p.address, p.prefix, p.family) }
    if (lists.size > 20) lists.clear()
    lists.set(key, list)
  }
  return list
}

/** Whether an address falls inside the list (an empty list allows all). */
export function allowedFrom(networks: readonly string[], ip: string): boolean {
  if (!networks.length) return true
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1]
  const addr = mapped ?? ip
  const v = isIP(addr)
  if (!v) return false
  return listFor(networks).check(addr, v === 4 ? 'ipv4' : 'ipv6')
}

/** Refuses a sign-in or refresh from outside the list, unless the account is
 *  an owner. */
export async function assertNetwork(app: App, userId: string, ip: string): Promise<void> {
  const { policy } = await getSettings(app)
  if (allowedFrom(policy.allowedNetworks, ip)) return
  const profile = await app.store.get(userPk(userId), PROFILE_SK)
  const role = profile ? roleFromDigest(app, String(profile['emailDigest']), (await getRegistry(app, userId))?.role) : 'user'
  if (role === 'owner') return
  throw new HttpError(403, 'network_not_allowed', 'Signing in from this network is not allowed on this server. Ask your administrator.')
}
