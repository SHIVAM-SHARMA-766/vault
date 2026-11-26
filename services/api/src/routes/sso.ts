// Single sign-on (decisions/0021, option 1). The identity provider replaces
// "who are you", never "open the vault":
//
//   1. GET  /api/auth/sso/start     → 302 to the provider, with state, nonce, PKCE
//   2. GET  /api/auth/sso/callback  ← the provider's code; the server exchanges
//      it, checks the ID token, and sends the browser to /app/#sso=<ticket>
//   3. POST /api/auth/sso/ticket    → which account the ticket is for
//   4. POST /api/auth/login { …, ssoTicket } with the master password as usual
//
// A ticket is random, single use, lives five minutes and is stored as a hash.
// It travels in the URL fragment, which browsers never send to a server or
// put in a Referer, so it stays out of logs.

import { createHash } from 'node:crypto'

import type { App } from '../context.js'
import { HttpError, type LambdaEvent, type LambdaResponse, json, notFound, parseJsonBody, redirect } from '../http.js'
import { emailDigest } from '../identity.js'
import { EMAIL_SK, emailPk } from '../keys.js'
import { OidcError, discover, exchangeCode, pkceChallenge, randomToken, redirectUri, verifyIdToken } from '../oidc.js'
import { SSO_LIMIT, enforce } from '../ratelimit.js'
import { roleFromDigest } from '../roles.js'
import { AlreadyExists } from '../store.js'
import { getRegistry, getSettings } from '../system.js'

const PK = 'SSO'
const STATE_SECONDS = 10 * 60
const TICKET_SECONDS = 5 * 60
const hash = (s: string) => createHash('sha256').update(s).digest('base64url')
const seconds = (app: App) => Math.floor(app.now() / 1000)

export interface Ticket {
  /** Set when the address has an account here. */
  userId?: string
  emailDigest: string
  /** Kept for five minutes so the browser can show who signed in. */
  email: string
  /** No account yet, and the operator lets the provider's people create one. */
  provision?: boolean
}

function requireOidc(app: App) {
  if (!app.config.oidc) throw notFound()
}

const back = (app: App, fragment: string) => redirect(`${app.config.origin}/app/#${fragment}`)

/** Step 1: off to the provider. */
export async function start(app: App, event: LambdaEvent): Promise<LambdaResponse> {
  requireOidc(app)
  await enforce(app.store, 'sso-ip', event.requestContext.http.sourceIp, SSO_LIMIT, app.now())
  let doc
  try { doc = await discover(app) } catch (err) { return back(app, `sso-error=${err instanceof OidcError ? err.code : 'provider_unavailable'}`) }
  const state = randomToken(), nonce = randomToken(), verifier = randomToken()
  await app.store.put({ pk: PK, sk: `S#${hash(state)}`, nonce, verifier, expiresAt: seconds(app) + STATE_SECONDS })
  const url = new URL(doc.authorization_endpoint)
  for (const [k, v] of Object.entries({
    response_type: 'code', client_id: app.config.oidc!.clientId, redirect_uri: redirectUri(app), scope: 'openid email profile',
    state, nonce, code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256',
  })) url.searchParams.set(k, v)
  return redirect(url.toString())
}

/** Step 2: the provider's answer. Every failure goes back to the app with a
 *  code it can explain, never a JSON page in the middle of a sign-in. */
export async function callback(app: App, event: LambdaEvent): Promise<LambdaResponse> {
  requireOidc(app)
  const q = new URLSearchParams(event.rawQueryString ?? '')
  const state = q.get('state') ?? ''
  if (q.get('error')) return back(app, `sso-error=${q.get('error') === 'access_denied' ? 'cancelled' : 'provider_error'}`)
  const saved = state ? await app.store.get(PK, `S#${hash(state)}`) : null
  if (!saved || Number(saved['expiresAt']) < seconds(app)) return back(app, 'sso-error=expired')
  await app.store.delete(PK, `S#${hash(state)}`)
  const code = q.get('code')
  if (!code) return back(app, 'sso-error=provider_error')

  let email: string
  try {
    const idToken = await exchangeCode(app, code, String(saved['verifier']))
    email = (await verifyIdToken(app, idToken, String(saved['nonce']))).email
  } catch (err) {
    return back(app, `sso-error=${err instanceof OidcError ? err.code : 'provider_unavailable'}`)
  }

  const digest = emailDigest(email, app.config.pepper)
  const pointer = await app.store.get(emailPk(digest), EMAIL_SK)
  const userId = typeof pointer?.['userId'] === 'string' ? pointer['userId'] : undefined
  if (!userId && !app.config.oidc!.provision) return back(app, 'sso-error=no_account')
  const ticket = randomToken()
  const record: Ticket = { emailDigest: digest, email, ...(userId ? { userId } : { provision: true }) }
  await app.store.put({ pk: PK, sk: `T#${hash(ticket)}`, ...record, expiresAt: seconds(app) + TICKET_SECONDS })
  return back(app, `sso=${ticket}`)
}

/** The ticket, if it is current and unused; it is not used up here. */
export async function readTicket(app: App, ticket: unknown): Promise<Ticket | null> {
  if (typeof ticket !== 'string' || ticket.length < 20 || ticket.length > 100) return null
  const row = await app.store.get(PK, `T#${hash(ticket)}`)
  if (!row || Number(row['expiresAt']) < seconds(app)) return null
  if (await app.store.get(PK, `U#${hash(ticket)}`)) return null
  return { emailDigest: String(row['emailDigest']), email: String(row['email']), ...(row['userId'] ? { userId: String(row['userId']) } : {}), ...(row['provision'] ? { provision: true } : {}) }
}

/** Uses the ticket up: true for the first caller only. */
export async function useTicket(app: App, ticket: string): Promise<boolean> {
  try {
    await app.store.put({ pk: PK, sk: `U#${hash(ticket)}`, expiresAt: seconds(app) + TICKET_SECONDS }, { mustNotExist: true })
  } catch (err) {
    if (err instanceof AlreadyExists) return false
    throw err
  }
  await app.store.delete(PK, `T#${hash(ticket)}`)
  return true
}

/** Step 3: who the ticket is for, so the app can ask for the right master
 *  password (or offer to create the account). */
export async function ticketInfo(app: App, event: LambdaEvent): Promise<LambdaResponse> {
  requireOidc(app)
  await enforce(app.store, 'sso-ip', event.requestContext.http.sourceIp, SSO_LIMIT, app.now())
  const t = await readTicket(app, parseJsonBody<{ ticket?: unknown }>(event).ticket)
  if (!t) throw new HttpError(401, 'sso_invalid', 'That single sign-on has expired. Sign in again.')
  const pointer = t.userId ? await app.store.get(emailPk(t.emailDigest), EMAIL_SK) : null
  return json(200, { email: t.email, exists: Boolean(t.userId), ...(pointer ? { kdf: pointer['kdf'] } : {}) })
}

/** Called by every sign-in path once the account is known. With a ticket, it
 *  must be for this account. Without one, it is refused when the server
 *  requires single sign-on, except for owners, so a broken provider cannot
 *  lock everyone out. Returns the ticket to use up once sign-in succeeds. */
export async function ssoGate(app: App, profile: { userId: string; emailDigest: string }, ticket: unknown): Promise<string | null> {
  if (ticket !== undefined && ticket !== null && ticket !== '') {
    const t = await readTicket(app, ticket)
    if (!t || t.userId !== profile.userId) throw new HttpError(401, 'sso_invalid', 'That single sign-on has expired or is for another account. Sign in again.')
    return ticket as string
  }
  if (!app.config.oidc || !(await getSettings(app)).policy.requireSso) return null
  const role = roleFromDigest(app, profile.emailDigest, (await getRegistry(app, profile.userId))?.role)
  if (role === 'owner') return null
  throw new HttpError(403, 'sso_required', `This server requires signing in with ${app.config.oidc.name} first.`)
}

/** For registration: a provisioning ticket for exactly this address. */
export async function provisionTicket(app: App, ticket: unknown, email: string): Promise<boolean> {
  const t = await readTicket(app, ticket)
  if (!t?.provision || t.emailDigest !== emailDigest(email, app.config.pepper)) return false
  return useTicket(app, ticket as string)
}

