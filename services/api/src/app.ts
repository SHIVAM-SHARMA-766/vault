// Routing table. Kept separate from the Lambda entry point so that tests can
// drive the same routes against an in-memory store, with no AWS involved.

import { randomUUID } from 'node:crypto'

import type { App } from './context.js'
import { requireUser } from './context.js'
import { type LambdaEvent, type LambdaResponse, errorResponse, json } from './http.js'
import { API_LIMIT, enforce } from './ratelimit.js'
import { Router } from './router.js'
import { openapi } from './openapi.js'
import * as admin from './routes/admin.js'
import type { Permission, Role } from './roles.js'
import * as auth from './routes/auth.js'
import * as sessions from './routes/sessions.js'
import * as site from './routes/site.js'
import * as vault from './routes/vault.js'

export function buildRouter(app: App): Router {
  const router = new Router()

  router.get('/api/health', async () => json(200, { status: 'ok' }), 'Liveness check')
  router.get('/api/openapi.json', async () => json(200, openapi(router)), 'This document')

  router.post('/api/auth/prelogin', ({ event }) => auth.prelogin(app, event), 'KDF parameters for an address (a decoy for unknown ones)')
  router.post('/api/auth/register', ({ event }) => auth.register(app, event), 'Create an account')
  router.post('/api/auth/login', ({ event }) => auth.login(app, event), 'Sign in with the auth key (and second factor)')
  router.post('/api/auth/recovery-login', ({ event }) => auth.recoveryLogin(app, event), 'Sign in with the recovery key\'s proof')
  router.post('/api/auth/refresh', ({ event }) => auth.refresh(app, event), 'Rotate a refresh token for a new session pair')
  router.post('/api/auth/signout', ({ event }) => auth.signOut(app, event), 'End the session a refresh token belongs to')

  // Everything below needs a valid access token.
  const authed =
    (handler: (userId: string, event: LambdaEvent, param: string) => Promise<LambdaResponse>) =>
    Object.assign(async ({ event, param }: { event: LambdaEvent; param: string }) => {
      const userId = requireUser(app, event)
      await enforce(app.store, 'api', userId, API_LIMIT, app.now())
      return handler(userId, event, param)
    }, { auth: 'access' as const })

  router.post('/api/auth/logout', authed((u, e) => auth.logout(app, u, e)), 'Revoke one session, or all of them')
  router.get('/api/auth/me', authed((u) => auth.me(app, u)), 'Profile, KDF parameters and wrapped vault key')
  router.post('/api/auth/change-password', authed((u, e) => auth.changePassword(app, u, e)), 'Rewrap the vault key under a new master password')
  router.post('/api/auth/recovery/rotate', authed((u, e) => auth.rotateRecovery(app, u, e)), 'Replace the recovery key')
  router.put('/api/keys/identity', authed((u, e) => auth.setIdentity(app, u, e)), 'Store the identity key pair (once)')
  router.post('/api/auth/2fa/setup', authed((u, e) => auth.setupTwoFactor(app, u, e)), 'Start TOTP enrolment')
  router.post('/api/auth/2fa/enable', authed((u, e) => auth.enableTwoFactor(app, u, e)), 'Confirm TOTP enrolment; returns recovery codes')
  router.post('/api/auth/2fa/disable', authed((u, e) => auth.disableTwoFactor(app, u, e)), 'Turn two-factor sign-in off')
  router.post('/api/auth/2fa/recovery-codes', authed((u, e) => auth.regenerateRecoveryCodes(app, u, e)), 'Replace the two-factor recovery codes')

  router.get('/api/sessions', authed((_u, e) => sessions.list(app, e)), 'Signed-in devices')
  router.put('/api/sessions/:id/name', authed((u, e, id) => sessions.rename(app, u, e, id)), 'Name a device')
  router.delete('/api/sessions/:id', authed((u, e, id) => sessions.revoke(app, u, e, id)), 'Sign a device out')

  router.get('/api/vault', authed((u) => vault.getVault(app, u)), 'Every sealed entry and folder')
  router.put('/api/vault/entries/:id', authed((u, e, id) => vault.putEntry(app, u, e, id)), 'Create or replace a sealed entry')
  router.delete('/api/vault/entries/:id', authed((u, _e, id) => vault.deleteEntry(app, u, id)), 'Delete an entry and its history')
  router.put('/api/vault/folders/:id', authed((u, e, id) => vault.putFolder(app, u, e, id)), 'Create or replace a sealed folder')
  router.delete('/api/vault/folders/:id', authed((u, _e, id) => vault.deleteFolder(app, u, id)), 'Delete a folder')
  router.get('/api/vault/history/:id', authed((u, _e, id) => vault.getHistory(app, u, id)), 'Previous versions of an entry')
  router.post('/api/vault/import', authed((u, e) => vault.bulkImport(app, u, e)), 'Create many sealed items at once; never overwrites')
  router.post('/api/vault/history/:id', authed((u, e, id) => vault.addHistory(app, u, e, id)), 'Add a sealed previous version')
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
  router.post('/api/admin/users/:id/revoke-sessions', admined('users.write', (u, _e, id, r) => admin.revokeSessions(app, u, r, id)), 'Sign an account out everywhere')
  router.post('/api/admin/users/:id/reset-2fa', admined('users.write', (u, _e, id, r) => admin.resetTwoFactor(app, u, r, id)), 'Turn off an account\'s two-factor sign-in')
  router.post('/api/admin/users/:id/delete', admined('users.write', (u, e, id, r) => admin.deleteUser(app, u, r, e, id)), 'Delete an account and its vault')
  router.get('/api/admin/settings', admined('overview.read', () => admin.getSettingsRoute(app)), 'Registration mode')
  router.put('/api/admin/settings', admined('settings.write', (u, e) => admin.putSettingsRoute(app, u, e)), 'Change the registration mode')
  router.get('/api/admin/invites', admined('invites.read', () => admin.listInvitesRoute(app)), 'Open invitations')
  router.post('/api/admin/invites', admined('invites.write', (u, e, _p, r) => admin.createInviteRoute(app, u, r, e)), 'Create an invitation code')
  router.delete('/api/admin/invites/:id', admined('invites.write', (u, _e, id) => admin.deleteInviteRoute(app, u, id)), 'Withdraw an invitation')
  router.get('/api/admin/audit', admined('audit.read', () => admin.auditRoute(app)), 'Staff audit log')

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
