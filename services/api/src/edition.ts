// Editions (decisions/0030): which features a server has. One codebase; the
// EDITION setting decides. A feature that is off is refused here, before any
// route runs, so a hidden menu cannot be reached by URL either.
//
//   personal  one account, its own admin: no organizations, invitations,
//             service desk, website editor, staff roles or emergency access
//   business  the company's server: everything but the website editor
//   hosted    the operator's service: everything (and the default, so an
//             existing install keeps working unchanged)

import type { App } from './context.js'
import { HttpError } from './http.js'
import { SYSTEM_ORG_PREFIX, SYSTEM_PK } from './keys.js'
import { listRegistry } from './system.js'

export const EDITIONS = ['personal', 'business', 'hosted'] as const
export type Edition = (typeof EDITIONS)[number]

export interface Features {
  /** Organizations, collections, groups, sharing with a person. */
  organizations: boolean
  /** Server invitations and registration beyond the owner. */
  invitations: boolean
  serviceDesk: boolean
  website: boolean
  /** Granting staff roles (admin, support, marketing, viewer). */
  staffRoles: boolean
  emergencyAccess: boolean
}

export function featuresOf(edition: Edition): Features {
  const all = edition !== 'personal'
  return {
    organizations: all,
    invitations: all,
    serviceDesk: all,
    website: edition === 'hosted',
    staffRoles: all,
    emergencyAccess: all,
  }
}

/** The paths each feature owns. */
const GATES: [RegExp, keyof Features][] = [
  [/^\/api\/orgs(\/|$)/, 'organizations'],
  [/^\/api\/admin\/orgs(\/|$)/, 'organizations'],
  [/^\/api\/admin\/invites(\/|$)/, 'invitations'],
  [/^\/api\/(admin\/)?desk(\/|$)/, 'serviceDesk'],
  [/^\/api\/admin\/(site|media)(\/|$)/, 'website'],
  [/^\/api\/admin\/users\/[^/]+\/role$/, 'staffRoles'],
  [/^\/api\/emergency(\/|$)/, 'emergencyAccess'],
]

/** The feature a path belongs to, when this edition does not have it. */
export function gatedFeature(edition: Edition, path: string): keyof Features | null {
  const features = featuresOf(edition)
  for (const [pattern, feature] of GATES) if (pattern.test(path) && !features[feature]) return feature
  return null
}

export function refuseIfGated(edition: Edition, path: string): void {
  const feature = gatedFeature(edition, path)
  if (feature) throw new HttpError(404, 'not_in_edition', `This ${edition} Vault does not include that feature.`)
}

/** Refuses to start an edition smaller than the data already on the server:
 *  a personal server with a second account or an organization. Moving up is
 *  always allowed (0030). */
export async function checkEditionFits(app: App): Promise<void> {
  if (app.config.edition !== 'personal') return
  const accounts = (await listRegistry(app)).length
  const orgs = (await app.store.query(SYSTEM_PK, SYSTEM_ORG_PREFIX)).length
  if (accounts > 1 || orgs > 0) {
    throw new Error(`EDITION=personal, but this server has ${accounts} accounts and ${orgs} organizations. A personal Vault has one account and none; set EDITION=business or hosted (decisions/0030).`)
  }
}
