// Routing table. Kept separate from the Lambda entry point so that tests can
// drive the same routes against an in-memory store, with no AWS involved.

import { refuseIfGated } from './edition.js'
import { randomUUID } from 'node:crypto'

import type { App } from './context.js'
import { requireLiveSession } from './context.js'
import { type LambdaEvent, type LambdaResponse, errorResponse, json } from './http.js'
import { API_LIMIT, enforce } from './ratelimit.js'
import { Router } from './router.js'
import { openapi } from './openapi.js'
import * as account from './routes/account.js'
import * as admin from './routes/admin.js'
import type { Permission, Role } from './roles.js'
import * as auth from './routes/auth.js'
import * as backups from './routes/backups.js'
import * as desk from './routes/desk.js'
import * as emergency from './routes/emergency.js'
import * as orgs from './routes/orgs.js'
import * as prefs from './routes/prefs.js'
import * as shares from './routes/shares.js'
import * as attachments from './routes/attachments.js'
import * as webauthn from './routes/webauthn.js'
import * as passkeys from './routes/passkeys.js'
import { breachRange } from './breach.js'
import { listNotes, readNotes } from './inbox.js'
import { metricsRoute, recordRequest } from './metrics.js'
import * as sessions from './routes/sessions.js'
import * as site from './routes/site.js'
import * as vault from './routes/vault.js'

export function buildRouter(app: App): Router {
  const router = new Router()
  // Features this edition does not have are refused before any route runs
  // (decisions/0030).
  const handle = router.handle.bind(router)
  router.handle = async (event) => { refuseIfGated(app.config.edition, event.rawPath); return handle(event) }

  router.get('/api/instance', () => admin.instanceRoute(app), 'This server\'s name, support contact and registration mode')
  router.get('/api/health', async () => json(200, { status: 'ok' }), 'Liveness check')
  router.get('/api/openapi.json', async () => json(200, openapi(router)), 'This document')

  router.post('/api/auth/prelogin', ({ event }) => auth.prelogin(app, event), 'KDF parameters for an address (a decoy for unknown ones)')
  router.post('/api/auth/register', ({ event }) => auth.register(app, event), 'Create an account')
  router.post('/api/auth/login', ({ event }) => auth.login(app, event), 'Sign in with the auth key (and second factor)')
  router.post('/api/auth/passkey-login/options', ({ event }) => passkeys.loginOptions(app, event), 'Start signing in with a passkey (no account named)')
  router.post('/api/auth/passkey-login', ({ event }) => passkeys.login(app, event), 'Sign in with a passkey; returns the passkey-wrapped vault key')
  router.post('/api/auth/recovery-login', ({ event }) => auth.recoveryLogin(app, event), 'Sign in with the recovery key\'s proof')
  router.post('/api/auth/refresh', ({ event }) => auth.refresh(app, event), 'Rotate a refresh token for a new session pair')
  router.post('/api/desk/requests', ({ event }) => desk.publicRequest(app, event), 'Ask for access, or for help signing in (no account needed)')
  router.post('/api/auth/signout', ({ event }) => auth.signOut(app, event), 'End the session a refresh token belongs to')

  // Everything below needs a valid access token.
  const authed =
    (handler: (userId: string, event: LambdaEvent, param: string) => Promise<LambdaResponse>) =>
    Object.assign(async ({ event, param }: { event: LambdaEvent; param: string }) => {
      const { userId } = await requireLiveSession(app, event)
      await enforce(app.store, 'api', userId, API_LIMIT, app.now())
      return handler(userId, event, param)
    }, { auth: 'access' as const })

  // The same, for routes with several path parameters.
  const authedP =
    (handler: (userId: string, event: LambdaEvent, params: string[]) => Promise<LambdaResponse>) =>
    Object.assign(async ({ event, params }: { event: LambdaEvent; params: string[] }) => {
      const { userId } = await requireLiveSession(app, event)
      await enforce(app.store, 'api', userId, API_LIMIT, app.now())
      return handler(userId, event, params)
    }, { auth: 'access' as const })

  router.post('/api/auth/logout', authed((u, e) => auth.logout(app, u, e)), 'Revoke one session, or all of them')
  router.put('/api/auth/password-score', authed((u, e) => auth.setPasswordScore(app, u, e)), 'Report the master password\'s strength score, for organization and server policies')
  router.get('/api/auth/me', authed((u) => auth.me(app, u)), 'Profile, KDF parameters and wrapped vault key')
  router.post('/api/auth/change-password', authed((u, e) => auth.changePassword(app, u, e)), 'Rewrap the vault key under a new master password')
  router.post('/api/auth/recovery/rotate', authed((u, e) => auth.rotateRecovery(app, u, e)), 'Replace the recovery key')
  router.get('/api/account/alerts', authed((u) => account.getAlerts(app, u)), 'My email alert settings')
  router.put('/api/account/alerts', authed((u, e) => account.putAlerts(app, u, e)), 'Turn the sign-in email on or off')
  router.post('/api/account/delete', authed((u, e) => account.deleteOwnAccount(app, u, e)), 'Delete my own account (master password and second factor required)')
  router.put('/api/keys/identity', authed((u, e) => auth.setIdentity(app, u, e)), 'Store the identity key pair (once)')
  router.post('/api/auth/identity/signing', authed((u, e) => auth.setSigningKey(app, u, e)), 'Enrol my signing key (once)')
  router.post('/api/auth/2fa/setup', authed((u, e) => auth.setupTwoFactor(app, u, e)), 'Start TOTP enrolment')
  router.post('/api/auth/2fa/enable', authed((u, e) => auth.enableTwoFactor(app, u, e)), 'Confirm TOTP enrolment; returns recovery codes')
  router.post('/api/auth/2fa/disable', authed((u, e) => auth.disableTwoFactor(app, u, e)), 'Turn two-factor sign-in off')
  router.post('/api/auth/2fa/webauthn/options', authed((u, e) => webauthn.registerOptions(app, u, e)), 'Start adding a passkey or security key (master password required)')
  router.post('/api/auth/2fa/webauthn', authed((u, e) => webauthn.register(app, u, e)), 'Finish adding a passkey or security key')
  router.post('/api/auth/2fa/webauthn/:id/remove', authed((u, e, id) => webauthn.removeKey(app, u, e, id)), 'Remove a passkey or security key (password and second factor)')
  router.post('/api/auth/passkeys/options', authed((u, e) => passkeys.enrolOptions(app, u, e)), 'Start adding a passkey that unlocks the vault (master password required)')
  router.post('/api/auth/passkeys', authed((u, e) => passkeys.enrol(app, u, e)), 'Finish adding a passkey, with the vault key it wraps')
  router.delete('/api/auth/passkeys/:id', authed((u, e, id) => passkeys.remove(app, u, e, id)), 'Remove a passkey that unlocks the vault')
  router.post('/api/auth/2fa/recovery-codes', authed((u, e) => auth.regenerateRecoveryCodes(app, u, e)), 'Replace the two-factor recovery codes')

  router.get('/api/sessions', authed((_u, e) => sessions.list(app, e)), 'Signed-in devices')
  router.put('/api/sessions/:id/name', authed((u, e, id) => sessions.rename(app, u, e, id)), 'Name a device')
  router.delete('/api/sessions/:id', authed((u, e, id) => sessions.revoke(app, u, e, id)), 'Sign a device out')

  router.get('/api/desk/tickets', authed((u) => desk.myTickets(app, u)), 'My support tickets')
  router.post('/api/desk/tickets', authed((u, e) => desk.createTicket(app, u, e)), 'Open a support ticket')
  router.get('/api/desk/tickets/:id', authed((u, _e, id) => desk.getMyTicket(app, u, id)), 'One of my tickets and its conversation')
  router.post('/api/desk/tickets/:id/messages', authed((u, e, id) => desk.replyAsRequester(app, u, e, id)), 'Reply to my ticket')
  router.post('/api/desk/tickets/:id/close', authed((u, _e, id) => desk.closeAsRequester(app, u, id)), 'Close my ticket')

  // Emergency access (routes/emergency.ts).
  router.get('/api/emergency', authed((u) => emergency.mine(app, u)), 'People who may request access to my vault')
  router.post('/api/emergency', authed((u, e) => emergency.create(app, u, e)), 'Name a trusted contact for emergency access')
  router.get('/api/emergency/trusted', authed((u) => emergency.trusted(app, u)), 'Vaults I may request access to, and invitations')
  router.post('/api/emergency/:id/accept', authed((u, _e, id) => emergency.accept(app, u, id)), 'Accept being a trusted contact')
  router.post('/api/emergency/:id/confirm', authed((u, e, id) => emergency.confirm(app, u, e, id)), 'Confirm a contact by fingerprint: seal my vault key to them')
  router.post('/api/emergency/:id/request', authed((u, e, id) => emergency.request(app, u, e, id)), 'Request emergency access')
  router.post('/api/emergency/:id/approve', authed((u, _e, id) => emergency.decide(app, u, id, true)), 'Approve a pending request now')
  router.post('/api/emergency/:id/reject', authed((u, _e, id) => emergency.decide(app, u, id, false)), 'Reject a pending request')
  router.delete('/api/emergency/:id', authed((u, _e, id) => emergency.revoke(app, u, id)), 'Remove a trusted contact')
  router.get('/api/emergency/:id/vault', authed((u, e, id) => emergency.vault(app, u, e, id)), 'The grantor\'s sealed vault, read-only, once access is open')

  // Organizations, collections and shared items (routes/orgs.ts).
  router.get('/api/orgs', authed((u) => orgs.myOrgs(app, u)), 'My organizations, with my sealed org key')
  router.post('/api/orgs', authed((u, e) => orgs.createOrg(app, u, e)), 'Create an organization')
  router.get('/api/orgs/invitations', authed((u) => orgs.myInvitations(app, u)), 'Invitations waiting for me')
  router.delete('/api/orgs/:org', authedP((u, _e, [o]) => orgs.deleteOrg(app, u, o!)), 'Delete an organization (owner)')
  router.get('/api/orgs/:org/stale', authedP((u, _e, [o]) => orgs.staleItems(app, u, o!)), 'Items whose password someone who left could have seen')
  router.put('/api/orgs/:org/recovery', authedP((u, e, [o]) => orgs.setRecovery(app, u, e, o!)), 'Set or replace the organization recovery key (owner)')
  router.get('/api/orgs/:org/recovery', authedP((u, _e, [o]) => orgs.getRecovery(app, u, o!)), 'The recovery escrow and copies (ciphertext only the recovery key opens)')
  router.post('/api/orgs/:org/recover', authedP((u, e, [o]) => orgs.recoverOrg(app, u, e, o!)), 'Recover an organization with its recovery key')
  router.put('/api/orgs/:org/collections/:coll/recovery-blob', authedP((u, e, [o, c]) => orgs.setCollectionRecovery(app, u, e, o!, c!)), 'Add a collection key copy sealed to the recovery key')
  router.post('/api/orgs/:org/members/:user/reconfirm', authedP((u, _e, [o, t]) => orgs.reconfirmMember(app, u, o!, t!)), 'Re-confirm a member whose fingerprint changed (signing key added)')
  router.post('/api/orgs/:org/members/:user/endorse', authedP((u, e, [o, t]) => orgs.endorseAdmin(app, u, e, o!, t!)), 'The owner endorses an admin to sign grants')
  router.get('/api/orgs/:org/trust', authedP((u, _e, [o]) => orgs.getTrust(app, u, o!)), 'My sealed trust store for this organization')
  router.put('/api/orgs/:org/trust', authedP((u, e, [o]) => orgs.putTrust(app, u, e, o!)), 'Save my sealed trust store for this organization')
  router.post('/api/orgs/:org/accept', authedP((u, _e, [o]) => orgs.acceptInvite(app, u, o!)), 'Accept an invitation')
  router.post('/api/orgs/:org/decline', authedP((u, _e, [o]) => orgs.declineInvite(app, u, o!)), 'Decline an invitation')
  router.get('/api/orgs/:org/members', authedP((u, _e, [o]) => orgs.members(app, u, o!)), 'Members, with public keys, and pending invitations')
  router.get('/api/orgs/:org/permission-sets', authedP((u, _e, [o]) => orgs.listPermissionSets(app, u, o!)), 'Built-in and custom permission sets')
  router.put('/api/orgs/:org/permission-sets/:id', authedP((u, e, [o, i]) => orgs.putPermissionSet(app, u, e, o!, i!)), 'Create or change a custom permission set (admins)')
  router.delete('/api/orgs/:org/permission-sets/:id', authedP((u, _e, [o, i]) => orgs.deletePermissionSet(app, u, o!, i!)), 'Remove a custom permission set that is not in use (admins)')
  router.post('/api/orgs/:org/invites', authedP((u, e, [o]) => orgs.invite(app, u, e, o!)), 'Invite someone by email address, or an existing account by id (business: with a sign-up code)')
  router.delete('/api/orgs/:org/invites/:digest', authedP((u, _e, [o, d]) => orgs.withdrawInvite(app, u, o!, d!)), 'Withdraw an invitation')
  router.post('/api/orgs/:org/members/:user/confirm', authedP((u, e, [o, t]) => orgs.confirmMember(app, u, e, o!, t!)), 'Confirm a member by fingerprint: send them the org key')
  router.put('/api/orgs/:org/members/:user', authedP((u, e, [o, t]) => orgs.setMemberRole(app, u, e, o!, t!)), 'Change a member\'s role (owner)')
  router.delete('/api/orgs/:org/members/:user', authedP((u, _e, [o, t]) => orgs.removeMember(app, u, o!, t!)), 'Remove a member, or leave')
  router.put('/api/orgs/:org/policies', authedP((u, e, [o]) => orgs.setPolicies(app, u, e, o!)), 'Set the organization\'s policies')
  router.get('/api/orgs/:org/compliance', authedP((u, _e, [o]) => orgs.compliance(app, u, o!)), 'Which members do not meet the policies')
  router.post('/api/orgs/:org/events', authedP((u, e, [o]) => orgs.reportEvent(app, u, e, o!)), 'Report opening, revealing or copying a shared item')
  router.get('/api/orgs/:org/events', authedP((u, _e, [o]) => orgs.events(app, u, o!)), 'The organization\'s access audit (admins)')
  router.get('/api/orgs/:org/groups', authedP((u, _e, [o]) => orgs.groups(app, u, o!)), 'Groups, their members and the collections granted to them')
  router.post('/api/orgs/:org/groups', authedP((u, e, [o]) => orgs.createGroup(app, u, e, o!)), 'Create a group')
  router.delete('/api/orgs/:org/groups/:group', authedP((u, _e, [o, g]) => orgs.deleteGroup(app, u, o!, g!)), 'Delete a group and the access it granted')
  router.put('/api/orgs/:org/groups/:group/members/:user', authedP((u, _e, [o, g, t]) => orgs.addGroupMember(app, u, o!, g!, t!)), 'Add a member to a group')
  router.delete('/api/orgs/:org/groups/:group/members/:user', authedP((u, _e, [o, g, t]) => orgs.removeGroupMember(app, u, o!, g!, t!)), 'Remove a member from a group')
  router.put('/api/orgs/:org/collections/:coll/groups/:group', authedP((u, e, [o, c, g]) => orgs.grantGroup(app, u, e, o!, c!, g!)), 'Grant a collection to a group')
  router.delete('/api/orgs/:org/collections/:coll/groups/:group', authedP((u, _e, [o, c, g]) => orgs.revokeGroup(app, u, o!, c!, g!)), 'Revoke a group\'s access to a collection')
  router.get('/api/orgs/:org/collections', authedP((u, _e, [o]) => orgs.collections(app, u, o!)), 'Collections, with my sealed key for each I can open')
  router.post('/api/orgs/:org/collections', authedP((u, e, [o]) => orgs.createCollection(app, u, e, o!)), 'Create a collection')
  router.put('/api/orgs/:org/collections/:coll', authedP((u, e, [o, c]) => orgs.renameCollection(app, u, e, o!, c!)), 'Rename a collection')
  router.delete('/api/orgs/:org/collections/:coll', authedP((u, _e, [o, c]) => orgs.deleteCollection(app, u, o!, c!)), 'Delete a collection and its items')
  router.post('/api/orgs/:org/collections/:coll/rotate', authedP((u, e, [o, c]) => orgs.rotateCollection(app, u, e, o!, c!)), 'Replace a collection key: re-sealed grants and re-encrypted items, all at once')
  router.get('/api/orgs/:org/collections/:coll/access', authedP((u, _e, [o, c]) => orgs.collectionAccess(app, u, o!, c!)), 'Who can open a collection')
  router.put('/api/orgs/:org/collections/:coll/access/:user', authedP((u, e, [o, c, t]) => orgs.grantAccess(app, u, e, o!, c!, t!)), 'Grant or change a member\'s access')
  router.delete('/api/orgs/:org/collections/:coll/access/:user', authedP((u, _e, [o, c, t]) => orgs.revokeAccess(app, u, o!, c!, t!)), 'Revoke a member\'s access')
  router.get('/api/orgs/:org/collections/:coll/items', authedP((u, _e, [o, c]) => orgs.items(app, u, o!, c!)), 'The sealed items in a collection')
  router.put('/api/orgs/:org/collections/:coll/items/:item', authedP((u, e, [o, c, i]) => orgs.putItem(app, u, e, o!, c!, i!)), 'Create or replace a sealed item')
  router.delete('/api/orgs/:org/collections/:coll/items/:item', authedP((u, _e, [o, c, i]) => orgs.deleteItem(app, u, o!, c!, i!)), 'Delete an item')

  router.get('/api/vault', authed((u) => vault.getVault(app, u)), 'Every sealed entry and folder')
  router.put('/api/vault/entries/:id', authed((u, e, id) => vault.putEntry(app, u, e, id)), 'Create or replace a sealed entry')
  router.delete('/api/vault/entries/:id', authed((u, _e, id) => vault.deleteEntry(app, u, id)), 'Delete an entry and its history')
  router.put('/api/vault/folders/:id', authed((u, e, id) => vault.putFolder(app, u, e, id)), 'Create or replace a sealed folder')
  router.delete('/api/vault/folders/:id', authed((u, _e, id) => vault.deleteFolder(app, u, id)), 'Delete a folder')
  router.get('/api/vault/history/:id', authed((u, _e, id) => vault.getHistory(app, u, id)), 'Previous versions of an entry')
  router.post('/api/vault/import', authed((u, e) => vault.bulkImport(app, u, e)), 'Create many sealed items at once; never overwrites')
  router.post('/api/vault/history/:id', authed((u, e, id) => vault.addHistory(app, u, e, id)), 'Add a sealed previous version')
  router.post('/api/shares', authed((u, e) => shares.createShare(app, u, e)), 'Create a share link for one item (sealed in the browser; the key stays in the link)')
  router.get('/api/shares', authed((u) => shares.listShares(app, u)), 'My share links and their status')
  router.delete('/api/shares/:id', authed((u, _e, id) => shares.revokeShare(app, u, id)), 'Revoke one of my share links')
  router.post('/api/shares/:id/open', ({ event, param }) => shares.openShare(app, event, param), 'Open a share link (no account needed; counts one view)')
  router.get('/api/breach/range/:prefix', authed((u, _e, prefix) => breachRange(app, u, prefix)), 'Pwned Passwords range for a 5-character SHA-1 prefix, relayed for the breach check')
  router.get('/api/metrics', ({ event }) => metricsRoute(app, event), 'Prometheus metrics for a scraper holding METRICS_TOKEN (counts only)')
  router.get('/api/attachments', authed((u) => attachments.attachmentUsage(app, u)), 'How much of my attachment quota is in use')
  router.put('/api/attachments/:id', authed((u, e, id) => attachments.putAttachment(app, u, e, id)), 'Store an encrypted attachment (its key stays in the sealed entry)')
  router.get('/api/attachments/:id', authed((u, _e, id) => attachments.getAttachment(app, u, id)), 'Fetch an encrypted attachment')
  router.delete('/api/attachments/:id', authed((u, _e, id) => attachments.deleteAttachment(app, u, id)), 'Delete an attachment')
  router.get('/api/notifications', authed((u) => listNotes(app, u)), 'My notifications, newest first')
  router.post('/api/notifications/read', authed((u, e) => readNotes(app, u, e)), 'Mark some or all of my notifications as read')
  router.post('/api/orgs/:org/collections/:coll/request', authedP((u, e, [o, c]) => orgs.requestAccess(app, u, e, o!, c!)), 'Ask for access to a collection')
  router.get('/api/orgs/:org/requests', authedP((u, _e, [o]) => orgs.listRequests(app, u, o!)), 'Access requests waiting (owner and admins)')
  router.delete('/api/orgs/:org/collections/:coll/request/:user', authedP((u, _e, [o, c, t]) => orgs.denyRequest(app, u, o!, c!, t!)), 'Turn down an access request')
  router.put('/api/orgs/:org/collections/:coll/items/:item/sensitive', authedP((u, e, [o, c, i]) => orgs.setSensitive(app, u, e, o!, c!, i!)), 'Mark an item sensitive: admins are told when it is opened')
  router.get('/api/prefs', authed((u) => prefs.getPrefs(app, u)), 'My sealed preferences')
  router.put('/api/prefs', authed((u, e) => prefs.putPrefs(app, u, e)), 'Replace my sealed preferences')
  router.get('/api/backups', authed((u) => backups.getBackups(app, u)), 'My backup schedule, destination, runs and copies')
  router.put('/api/backups/config', authed((u, e) => backups.putConfig(app, u, e)), 'Set my backup schedule and destination')
  router.post('/api/backups/run', authed((u) => backups.runNow(app, u)), 'Back up now')
  router.get('/api/backups/latest', authed((u) => backups.latest(app, u)), 'The newest backup, fetched back from its destination (for a test restore)')
  router.get('/api/backups/copies/:id', authed((u, _e, id) => backups.getCopy(app, u, id)), 'Download a copy kept on the server')
  router.delete('/api/backups/copies/:id', authed((u, _e, id) => backups.deleteCopy(app, u, id)), 'Delete a copy kept on the server')
  router.get('/api/activity', authed((u) => vault.getActivity(app, u)), 'Security events from the last ninety days')

  // The operator's routes. Same sign-in as everything else; each names the
  // permission it needs, and the caller's role is re-read on every request.
  // See roles.ts and routes/admin.ts.
  const admined =
    (permission: Permission,
     handler: (userId: string, event: LambdaEvent, param: string, role: Role) => Promise<LambdaResponse>) =>
    Object.assign(authed(async (userId, event, param) => {
      const role = await admin.guard(app, userId, permission)
      return handler(userId, event, param, role)
    }), { permission })

  router.get('/api/admin/overview', admined('overview.read', () => admin.overview(app)), 'Instance counts and health')
  router.get('/api/admin/users', admined('users.read', () => admin.listUsers(app)), 'Accounts on this server')
  router.put('/api/admin/users/:id/label', admined('users.write', (u, e, id, r) => admin.setLabel(app, u, r, e, id)), 'Label an account')
  router.put('/api/admin/users/:id/role', admined('roles.write', (u, e, id, r) => admin.setRole(app, u, r, e, id)), 'Change an account\'s staff role')
  router.put('/api/admin/users/:id/disabled', admined('users.write', (u, e, id, r) => admin.setDisabled(app, u, r, e, id)), 'Disable or enable an account')
  router.post('/api/admin/users/:id/offboard', admined('users.write', (u, _e, id, r) => admin.offboard(app, u, r, id)), 'Offboard an account: disable, sign out, remove from organizations')
  router.post('/api/admin/users/:id/revoke-sessions', admined('users.write', (u, _e, id, r) => admin.revokeSessions(app, u, r, id)), 'Sign an account out everywhere')
  router.post('/api/admin/users/:id/reset-2fa', admined('users.write', (u, _e, id, r) => admin.resetTwoFactor(app, u, r, id)), 'Turn off an account\'s two-factor sign-in')
  router.post('/api/admin/users/:id/delete', admined('users.write', (u, e, id, r) => admin.deleteUser(app, u, r, e, id)), 'Delete an account and its vault')
  router.get('/api/admin/settings', admined('overview.read', () => admin.getSettingsRoute(app)), 'Registration mode and instance profile')
  router.put('/api/admin/settings', admined('settings.write', (u, e) => admin.putSettingsRoute(app, u, e)), 'Change the registration mode or the instance profile')
  router.get('/api/admin/invites', admined('invites.read', () => admin.listInvitesRoute(app)), 'Open invitations')
  router.post('/api/admin/invites', admined('invites.write', (u, e, _p, r) => admin.createInviteRoute(app, u, r, e)), 'Create an invitation code')
  router.post('/api/admin/company-invites', admined('invites.write', (u, e) => admin.createCompanyInviteRoute(app, u, e)), 'Invite a company: the code lets its admin create one company (hosted)')
  router.post('/api/admin/invites/bulk', admined('invites.write', (u, e, _p, r) => admin.bulkInviteRoute(app, u, r, e)), 'Invite many people at once')
  router.post('/api/admin/invites/:id/resend', admined('invites.write', (u, e, id, r) => admin.resendInviteRoute(app, u, r, e, id)), 'Send an unused invitation again, with a fresh code')
  router.delete('/api/admin/invites/:id', admined('invites.write', (u, _e, id) => admin.deleteInviteRoute(app, u, id)), 'Withdraw an invitation')
  router.post('/api/admin/templates/preview', admined('overview.read', (_u, e) => admin.previewTemplate(app, e)), 'Preview an email template with sample details')
  router.get('/api/admin/limits', admined('overview.read', async () => admin.limitsRoute()), 'Rate limits, in words')
  router.get('/api/admin/backup', admined('overview.read', () => admin.backupStatus(app)), 'Server backup settings and the last run')
  router.post('/api/admin/backup/run', admined('settings.write', (u) => admin.requestBackup(app, u)), 'Ask the server to take a backup now')
  router.post('/api/admin/mail/test', admined('settings.write', (u, e) => admin.testMail(app, u, e)), 'Send a test email')
  router.get('/api/admin/orgs', admined('users.read', () => orgs.adminList(app)), 'Every organization, by counts (operator view)')
  router.delete('/api/admin/orgs/:org', admined('users.write', (u, _e, o) => admin.deleteOrgAsOperator(app, u, o)), 'Delete an organization and everything in it (operator, audited)')
  router.get('/api/admin/update', admined('overview.read', (_u, e) => admin.updateRoute(app, e)), 'This version, and whether a newer release is out')
  router.get('/api/admin/audit', admined('audit.read', () => admin.auditRoute(app)), 'Staff audit log')
  router.get('/api/admin/audit/export', admined('audit.read', (_u, e) => admin.auditExport(app, e)), 'Download the audit log as CSV or JSON')

  router.get('/api/admin/desk', admined('desk.read', () => desk.queue(app)), 'The service desk queue')
  router.get('/api/admin/desk/:id', admined('desk.read', (_u, _e, id) => desk.getForStaff(app, id)), 'A ticket with every message, internal notes included')
  router.post('/api/admin/desk/:id/messages', admined('desk.write', (u, e, id) => desk.replyAsStaff(app, u, e, id)), 'Reply to a ticket, or add an internal note')
  router.put('/api/admin/desk/:id', admined('desk.write', (u, e, id) => desk.updateTicket(app, u, e, id)), 'Change a ticket\'s status, priority or assignee')
  router.post('/api/admin/desk/:id/approve', admined('invites.write', (u, e, id, r) => desk.approveAccess(app, u, r, e, id)), 'Approve an access request: issue and email an invitation')
  router.post('/api/admin/desk/:id/reset-2fa', admined('users.write', (u, _e, id, r) => desk.resetTwoFactorFor(app, u, r, id)), 'Reset two-factor sign-in for a verified sign-in request')

  router.get('/api/admin/site', admined('site.read', () => site.getSite(app)), 'Website content, draft and versions')
  router.put('/api/admin/site/draft', admined('site.write', (u, e) => site.saveDraft(app, u, e)), 'Save a website draft')
  router.delete('/api/admin/site/draft', admined('site.write', (u) => site.discardDraft(app, u)), 'Discard the website draft')
  router.post('/api/admin/site/preview', admined('site.read', (_u, e) => site.preview(app, e)), 'Render a page from draft content')
  router.post('/api/admin/site/publish', admined('site.publish', (u, e) => site.publish(app, u, e)), 'Publish the website draft')
  router.post('/api/admin/site/rollback/:version', admined('site.publish', (u, _e, v) => site.rollback(app, u, v)), 'Restore a published website version')
  router.post('/api/admin/media', admined('site.write', (u, e) => site.uploadMedia(app, u, e)), 'Upload a website image')
  router.delete('/api/admin/media/:id', admined('site.write', (u, _e, id) => site.deleteMedia(app, u, id)), 'Delete a website image')

  return router
}

/** A request id: the one Caddy forwarded if it is plausible, otherwise new. */
function requestIdFor(event: LambdaEvent): string {
  const given = event.headers['x-request-id']
  return given && /^[A-Za-z0-9-]{8,64}$/.test(given) ? given : randomUUID()
}

/** Runs one request: routes it, turns failures into error responses, stamps
 *  the request id on the response, and (when `log` is set) writes one JSON
 *  line — no body, no query string, no address. */
export async function handleRequest(router: Router, event: LambdaEvent, opts: { log?: boolean } = {}): Promise<LambdaResponse> {
  const requestId = requestIdFor(event)
  const started = performance.now()
  let res: LambdaResponse
  try {
    res = await router.handle(event)
  } catch (err) {
    res = errorResponse(err, requestId)
  }
  res = { ...res, headers: { ...res.headers, 'x-request-id': requestId } }
  recordRequest(event.requestContext.http.method, res.statusCode, performance.now() - started)
  if (opts.log) {
    console.log(JSON.stringify({
      level: 'info', requestId, method: event.requestContext.http.method, path: event.rawPath,
      status: res.statusCode, ms: Math.round(performance.now() - started),
    }))
  }
  return res
}

export async function dispatch(app: App, event: LambdaEvent): Promise<LambdaResponse> {
  return handleRequest(buildRouter(app), event)
}
