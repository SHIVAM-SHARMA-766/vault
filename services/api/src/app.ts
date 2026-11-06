// Routing table. Kept separate from the Lambda entry point so that tests can
// drive the same routes against an in-memory store, with no AWS involved.

import type { App } from './context.js'
import { requireUser } from './context.js'
import { type LambdaEvent, type LambdaResponse, errorResponse, json } from './http.js'
import { API_LIMIT, enforce } from './ratelimit.js'
import { Router } from './router.js'
import * as admin from './routes/admin.js'
import type { Permission, Role } from './roles.js'
import * as auth from './routes/auth.js'
import * as site from './routes/site.js'
import * as vault from './routes/vault.js'

export function buildRouter(app: App): Router {
  const router = new Router()

  router.get('/api/health', async () => json(200, { status: 'ok' }))

  router.post('/api/auth/prelogin', ({ event }) => auth.prelogin(app, event))
  router.post('/api/auth/register', ({ event }) => auth.register(app, event))
  router.post('/api/auth/login', ({ event }) => auth.login(app, event))
  router.post('/api/auth/recovery-login', ({ event }) => auth.recoveryLogin(app, event))
  router.post('/api/auth/refresh', ({ event }) => auth.refresh(app, event))

  // Everything below needs a valid access token.
  const authed =
    (handler: (userId: string, event: LambdaEvent, param: string) => Promise<LambdaResponse>) =>
    async ({ event, param }: { event: LambdaEvent; param: string }) => {
      const userId = requireUser(app, event)
      await enforce(app.store, 'api', userId, API_LIMIT, app.now())
      return handler(userId, event, param)
    }

  router.post('/api/auth/logout', authed((u, e) => auth.logout(app, u, e)))
  router.get('/api/auth/me', authed((u) => auth.me(app, u)))
  router.post('/api/auth/change-password', authed((u, e) => auth.changePassword(app, u, e)))
  router.post('/api/auth/recovery/rotate', authed((u, e) => auth.rotateRecovery(app, u, e)))
  router.put('/api/keys/identity', authed((u, e) => auth.setIdentity(app, u, e)))
  router.post('/api/auth/2fa/setup', authed((u, e) => auth.setupTwoFactor(app, u, e)))
  router.post('/api/auth/2fa/enable', authed((u, e) => auth.enableTwoFactor(app, u, e)))
  router.post('/api/auth/2fa/disable', authed((u, e) => auth.disableTwoFactor(app, u, e)))
  router.post('/api/auth/2fa/recovery-codes', authed((u, e) => auth.regenerateRecoveryCodes(app, u, e)))

  router.get('/api/vault', authed((u) => vault.getVault(app, u)))
  router.put('/api/vault/entries/:id', authed((u, e, id) => vault.putEntry(app, u, e, id)))
  router.delete('/api/vault/entries/:id', authed((u, _e, id) => vault.deleteEntry(app, u, id)))
  router.put('/api/vault/folders/:id', authed((u, e, id) => vault.putFolder(app, u, e, id)))
  router.delete('/api/vault/folders/:id', authed((u, _e, id) => vault.deleteFolder(app, u, id)))
  router.get('/api/vault/history/:id', authed((u, _e, id) => vault.getHistory(app, u, id)))
  router.post('/api/vault/import', authed((u, e) => vault.bulkImport(app, u, e)))
  router.post('/api/vault/history/:id', authed((u, e, id) => vault.addHistory(app, u, e, id)))
  router.get('/api/activity', authed((u) => vault.getActivity(app, u)))

  // The operator's routes. Same sign-in as everything else; each names the
  // permission it needs, and the caller's role is re-read on every request.
  // See roles.ts and routes/admin.ts.
  const admined =
    (permission: Permission,
     handler: (userId: string, event: LambdaEvent, param: string, role: Role) => Promise<LambdaResponse>) =>
    authed(async (userId, event, param) => {
      const role = await admin.guard(app, userId, permission)
      return handler(userId, event, param, role)
    })

  router.get('/api/admin/overview', admined('overview.read', () => admin.overview(app)))
  router.get('/api/admin/users', admined('users.read', () => admin.listUsers(app)))
  router.put('/api/admin/users/:id/label', admined('users.write', (u, e, id, r) => admin.setLabel(app, u, r, e, id)))
  router.put('/api/admin/users/:id/role', admined('roles.write', (u, e, id, r) => admin.setRole(app, u, r, e, id)))
  router.put('/api/admin/users/:id/disabled', admined('users.write', (u, e, id, r) => admin.setDisabled(app, u, r, e, id)))
  router.post('/api/admin/users/:id/revoke-sessions', admined('users.write', (u, _e, id, r) => admin.revokeSessions(app, u, r, id)))
  router.post('/api/admin/users/:id/reset-2fa', admined('users.write', (u, _e, id, r) => admin.resetTwoFactor(app, u, r, id)))
  router.post('/api/admin/users/:id/delete', admined('users.write', (u, e, id, r) => admin.deleteUser(app, u, r, e, id)))
  router.get('/api/admin/settings', admined('overview.read', () => admin.getSettingsRoute(app)))
  router.put('/api/admin/settings', admined('settings.write', (u, e) => admin.putSettingsRoute(app, u, e)))
  router.get('/api/admin/invites', admined('invites.read', () => admin.listInvitesRoute(app)))
  router.post('/api/admin/invites', admined('invites.write', (u, e, _p, r) => admin.createInviteRoute(app, u, r, e)))
  router.delete('/api/admin/invites/:id', admined('invites.write', (u, _e, id) => admin.deleteInviteRoute(app, u, id)))
  router.get('/api/admin/audit', admined('audit.read', () => admin.auditRoute(app)))

  router.get('/api/admin/site', admined('site.read', () => site.getSite(app)))
  router.put('/api/admin/site/draft', admined('site.write', (u, e) => site.saveDraft(app, u, e)))
  router.delete('/api/admin/site/draft', admined('site.write', (u) => site.discardDraft(app, u)))
  router.post('/api/admin/site/preview', admined('site.read', (_u, e) => site.preview(app, e)))
  router.post('/api/admin/site/publish', admined('site.publish', (u, e) => site.publish(app, u, e)))
  router.post('/api/admin/site/rollback/:version', admined('site.publish', (u, _e, v) => site.rollback(app, u, v)))
  router.post('/api/admin/media', admined('site.write', (u, e) => site.uploadMedia(app, u, e)))
  router.delete('/api/admin/media/:id', admined('site.write', (u, _e, id) => site.deleteMedia(app, u, id)))

  return router
}

export async function dispatch(app: App, event: LambdaEvent): Promise<LambdaResponse> {
  try {
    return await buildRouter(app).handle(event)
  } catch (err) {
    return errorResponse(err)
  }
}
