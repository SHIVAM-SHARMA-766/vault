// Routing table. Kept separate from the Lambda entry point so that tests can
// drive the same routes against an in-memory store, with no AWS involved.

import type { App } from './context.js'
import { requireUser } from './context.js'
import { type LambdaEvent, type LambdaResponse, errorResponse, json } from './http.js'
import { API_LIMIT, enforce } from './ratelimit.js'
import { Router } from './router.js'
import * as auth from './routes/auth.js'
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

  router.get('/api/vault', authed((u) => vault.getVault(app, u)))
  router.put('/api/vault/entries/:id', authed((u, e, id) => vault.putEntry(app, u, e, id)))
  router.delete('/api/vault/entries/:id', authed((u, _e, id) => vault.deleteEntry(app, u, id)))
  router.put('/api/vault/folders/:id', authed((u, e, id) => vault.putFolder(app, u, e, id)))
  router.delete('/api/vault/folders/:id', authed((u, _e, id) => vault.deleteFolder(app, u, id)))
  router.get('/api/vault/history/:id', authed((u, _e, id) => vault.getHistory(app, u, id)))
  router.post('/api/vault/history/:id', authed((u, e, id) => vault.addHistory(app, u, e, id)))
  router.get('/api/activity', authed((u) => vault.getActivity(app, u)))

  return router
}

export async function dispatch(app: App, event: LambdaEvent): Promise<LambdaResponse> {
  try {
    return await buildRouter(app).handle(event)
  } catch (err) {
    return errorResponse(err)
  }
}
