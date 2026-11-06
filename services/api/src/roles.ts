// Who may do what in the admin panel. One table, read in one place.
//
// Owner comes from configuration on the host (ADMIN_EMAILS), never from the
// database, so a write to the table cannot create one. The other staff roles
// are granted by an owner and stored on the account's registry row. Everyone
// else is a plain user with no admin access at all.
//
// See decisions/0007-roles-and-site-editing.md.

import type { App } from './context.js'
import { forbidden } from './http.js'
import { PROFILE_SK, userPk } from './keys.js'
import { getRegistry } from './system.js'

export type Role = 'owner' | 'admin' | 'marketing' | 'viewer' | 'user'
/** The roles an owner can grant. Owner itself is not among them. */
export const GRANTABLE_ROLES = ['admin', 'marketing', 'viewer', 'user'] as const
export type GrantableRole = (typeof GRANTABLE_ROLES)[number]

export type Permission =
  | 'overview.read'
  | 'users.read'
  | 'users.write'
  | 'roles.write'
  | 'invites.read'
  | 'invites.write'
  | 'settings.write'
  | 'audit.read'
  | 'site.read'
  | 'site.write'
  | 'site.publish'

const PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: [
    'overview.read', 'users.read', 'users.write', 'roles.write', 'invites.read', 'invites.write',
    'settings.write', 'audit.read', 'site.read', 'site.write', 'site.publish',
  ],
  admin: [
    'overview.read', 'users.read', 'users.write', 'invites.read', 'invites.write',
    'settings.write', 'audit.read', 'site.read', 'site.write', 'site.publish',
  ],
  marketing: ['site.read', 'site.write', 'site.publish'],
  viewer: ['overview.read', 'users.read', 'invites.read', 'audit.read', 'site.read'],
  user: [],
}

export const permissionsOf = (role: Role): readonly Permission[] => PERMISSIONS[role]
export const can = (role: Role, permission: Permission): boolean => PERMISSIONS[role].includes(permission)
export const isStaff = (role: Role): boolean => role !== 'user'

/** Higher outranks lower. An admin may manage marketing, viewers and users,
 *  never another admin or an owner. */
const RANK: Record<Role, number> = { owner: 4, admin: 3, marketing: 2, viewer: 1, user: 0 }
export const outranks = (actor: Role, target: Role): boolean =>
  actor === 'owner' ? target !== 'owner' : RANK[actor] > RANK[target]

export function roleFromDigest(app: App, digest: string, stored: unknown): Role {
  if (app.adminDigests.has(digest)) return 'owner'
  return (GRANTABLE_ROLES as readonly string[]).includes(stored as string) ? (stored as GrantableRole) : 'user'
}

/** Reads the caller's profile and registry row. Nothing in the token is
 *  trusted for this: a role revoked a second ago is revoked now. */
export async function roleOf(app: App, userId: string): Promise<Role> {
  const profile = await app.store.get(userPk(userId), PROFILE_SK)
  const digest = profile?.['emailDigest']
  if (typeof digest !== 'string') return 'user'
  const reg = await getRegistry(app, userId)
  return roleFromDigest(app, digest, reg?.role)
}

export async function requirePermission(app: App, userId: string, permission: Permission): Promise<Role> {
  const role = await roleOf(app, userId)
  if (!can(role, permission)) throw forbidden()
  return role
}
