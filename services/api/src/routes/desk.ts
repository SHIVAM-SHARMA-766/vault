// The service desk: help and support inside the product.
//
// Three kinds of ticket:
//   access   — someone without an account asks to be let in (public)
//   signin   — someone cannot sign in, usually a lost authenticator (public)
//   support  — a signed-in user asks for help
//
// Staff with desk.read / desk.write work the queue in the admin panel; two
// actions close the common loops: approving an access request issues (and
// emails) an invitation, and a verified sign-in request can have two-factor
// sign-in reset by someone with users.write.
//
// Privacy. Ticket text is not vault data and staff can read it; the UI says
// never to put a password in it. Vault otherwise stores no email addresses,
// so a requester's address is kept on the ticket only while it is open — it
// is erased when the ticket closes, and resolved tickets close themselves
// after seven days (closeStaleTickets). Public requests are rate-limited and
// answer identically whether or not an address has an account (threat A7).

import { randomUUID } from 'node:crypto'

import type { App } from '../context.js'
import { HttpError, type LambdaEvent, type LambdaResponse, badRequest, forbidden, json, notFound, parseJsonBody } from '../http.js'
import { emailDigest } from '../identity.js'
import {
  DESK_PK, DESK_SEQ_SK, EMAIL_SK, MESSAGE_PREFIX, MESSAGE_SEQ_SK, PROFILE_SK, TICKET_PREFIX,
  emailPk, isValidId, messageSk, ticketPk, ticketSk, userPk,
} from '../keys.js'
import { notify } from '../mail.js'
import { enforce } from '../ratelimit.js'
import { type Role, can, outranks, roleOf } from '../roles.js'
import type { Item } from '../store.js'
import { audit, createInvite, getRegistry } from '../system.js'
import { requireEmail } from '../validate.js'

export type TicketKind = 'access' | 'signin' | 'support'
export type TicketStatus = 'open' | 'in_progress' | 'waiting' | 'resolved' | 'closed'
const STATUSES: readonly TicketStatus[] = ['open', 'in_progress', 'waiting', 'resolved', 'closed']
export const CATEGORIES = ['question', 'problem', 'account', 'feature'] as const

export interface Ticket extends Item {
  id: string
  number: number
  kind: TicketKind
  subject: string
  category: string
  status: TicketStatus
  priority: 'normal' | 'high'
  requester: { userId?: string; name?: string; email?: string; emailErased?: boolean }
  assignee?: string
  createdAt: string
  updatedAt: string
  /** Who spoke last, so the queue can show what is waiting on staff. */
  lastFrom: 'requester' | 'staff'
  closedAt?: string
}

interface MessageFields {
  from: 'requester' | 'staff'
  author: string
  body: string
  internal: boolean
}
interface Message extends Item, MessageFields {
  at: string
}

/** Public requests: per address and per email, so one source cannot flood the queue. */
const PUBLIC_LIMIT = { max: 5, windowSeconds: 60 * 60 }
const PUBLIC_EMAIL_LIMIT = { max: 3, windowSeconds: 24 * 60 * 60 }
const AUTO_CLOSE_DAYS = 7
const FAR_FUTURE = 4_102_444_800 // 2100-01-01: the sequence counter never expires

const text = (value: unknown, field: string, max: number, required = true): string => {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`${field} is required.`)
    return ''
  }
  if (typeof value !== 'string') throw badRequest(`${field} must be text.`)
  const t = value.trim()
  if (required && !t) throw badRequest(`${field} is required.`)
  if (t.length > max) throw badRequest(`${field} is at most ${max} characters.`)
  return t
}

async function nextNumber(app: App): Promise<number> {
  return app.store.increment(DESK_PK, DESK_SEQ_SK, FAR_FUTURE)
}

async function getTicket(app: App, id: string): Promise<Ticket> {
  if (!isValidId(id)) throw notFound()
  const t = (await app.store.get(DESK_PK, ticketSk(id))) as Ticket | null
  if (!t) throw notFound()
  return t
}

async function addMessage(app: App, id: string, m: MessageFields): Promise<Message> {
  const at = new Date(app.now()).toISOString()
  const seq = await app.store.increment(ticketPk(id), MESSAGE_SEQ_SK, FAR_FUTURE)
  const msg: Message = { pk: ticketPk(id), sk: messageSk(seq), at, ...m }
  await app.store.put(msg)
  return msg
}

async function messages(app: App, id: string, includeInternal: boolean) {
  const all = (await app.store.query(ticketPk(id), MESSAGE_PREFIX)) as Message[]
  return all.filter((m) => includeInternal || !m.internal)
    .map(({ at, from, author, body, internal }) => ({ at, from, author, body, internal }))
}

/** A ticket as the requester sees it: no assignee, no address. */
const forRequester = (t: Ticket) => ({
  id: t.id, number: t.number, kind: t.kind, subject: t.subject, category: t.category, status: t.status,
  createdAt: t.createdAt, updatedAt: t.updatedAt, lastFrom: t.lastFrom, emailUpdates: !!t.requester.email,
})

/** A ticket as staff see it. */
const forStaff = (t: Ticket) => ({
  ...forRequester(t), priority: t.priority, assignee: t.assignee ?? null,
  requester: { userId: t.requester.userId ?? null, name: t.requester.name ?? null, email: t.requester.email ?? null, emailErased: !!t.requester.emailErased },
  closedAt: t.closedAt ?? null,
})

async function save(app: App, t: Ticket, patch: Partial<Ticket>, opts: { clearAssignee?: boolean } = {}): Promise<Ticket> {
  const next: Ticket = { ...t, ...patch, updatedAt: new Date(app.now()).toISOString() }
  if (opts.clearAssignee) delete next.assignee
  if (next.status === 'closed' && t.status !== 'closed') {
    next.closedAt = next.updatedAt
    // The address was only ever held to answer this ticket.
    if (next.requester.email) {
      const { email: _erased, ...rest } = next.requester
      next.requester = { ...rest, emailErased: true }
    }
  }
  await app.store.put(next)
  return next
}

async function tellRequester(app: App, t: Ticket, subject: string, body: string): Promise<void> {
  if (!t.requester.email) return
  await notify(app.mailer, {
    to: t.requester.email,
    subject: `[Vault #${t.number}] ${subject}`,
    text: `${body}\n\n— Vault support at ${app.config.origin}${t.kind === 'support' ? `\nOpen Help & support to reply: ${app.config.origin}/app/support` : ''}\nThis address is kept only until the request is closed.`,
  })
}

// ── Public ────────────────────────────────────────────────────────────────

export async function publicRequest(app: App, event: LambdaEvent): Promise<LambdaResponse> {
  await enforce(app.store, 'desk-ip', event.requestContext.http.sourceIp, PUBLIC_LIMIT, app.now())
  const body = parseJsonBody<Record<string, unknown>>(event)
  const kind = body['kind']
  if (kind !== 'access' && kind !== 'signin') throw badRequest('kind must be "access" or "signin".')
  const email = requireEmail(body['email'])
  await enforce(app.store, 'desk-email', emailDigest(email, app.config.pepper), PUBLIC_EMAIL_LIMIT, app.now())
  const name = text(body['name'], 'name', 80)
  const message = text(body['message'], 'message', 2000, false)

  const id = randomUUID()
  const at = new Date(app.now()).toISOString()
  const ticket: Ticket = {
    pk: DESK_PK, sk: ticketSk(id), id, number: await nextNumber(app), kind,
    subject: kind === 'access' ? `Access request from ${name}` : `Cannot sign in: ${name}`,
    category: kind === 'access' ? 'account' : 'problem', status: 'open', priority: kind === 'signin' ? 'high' : 'normal',
    requester: { name, email }, createdAt: at, updatedAt: at, lastFrom: 'requester',
  }
  await app.store.put(ticket, { mustNotExist: true })
  await addMessage(app, id, { from: 'requester', author: name, body: message || '(no message)', internal: false })
  await tellRequester(app, ticket, 'We received your request', kind === 'access'
    ? 'Thank you. Someone who runs this Vault server will review your request. If it is approved you will receive an invitation.'
    : 'Thank you. Someone who runs this Vault server will contact you to confirm it is really you before changing anything on your account. Nobody can reset a forgotten master password — only your recovery key can.')
  // The same answer whether or not the address has an account.
  return json(201, { number: ticket.number })
}

// ── Requesters (signed in) ────────────────────────────────────────────────

export async function myTickets(app: App, userId: string): Promise<LambdaResponse> {
  const pointers = await app.store.query(userPk(userId), TICKET_PREFIX)
  const tickets = (await Promise.all(pointers.map((p) => app.store.get(DESK_PK, p.sk)))).filter((t): t is Ticket => !!t)
  tickets.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return json(200, { tickets: tickets.map(forRequester) })
}

export async function createTicket(app: App, userId: string, event: LambdaEvent): Promise<LambdaResponse> {
  const body = parseJsonBody<Record<string, unknown>>(event)
  const subject = text(body['subject'], 'subject', 120)
  const message = text(body['message'], 'message', 5000)
  const category = typeof body['category'] === 'string' && (CATEGORIES as readonly string[]).includes(body['category']) ? body['category'] : 'question'
  const email = body['email'] ? requireEmail(body['email']) : ''
  const reg = await getRegistry(app, userId)

  const id = randomUUID()
  const at = new Date(app.now()).toISOString()
  const ticket: Ticket = {
    pk: DESK_PK, sk: ticketSk(id), id, number: await nextNumber(app), kind: 'support', subject, category,
    status: 'open', priority: 'normal',
    requester: { userId, ...(reg?.label ? { name: reg.label } : {}), ...(email ? { email } : {}) },
    createdAt: at, updatedAt: at, lastFrom: 'requester',
  }
  await app.store.put(ticket, { mustNotExist: true })
  await app.store.put({ pk: userPk(userId), sk: ticketSk(id) })
  await addMessage(app, id, { from: 'requester', author: reg?.label || 'Member', body: message, internal: false })
  return json(201, { ticket: forRequester(ticket) })
}

async function ownTicket(app: App, userId: string, id: string): Promise<Ticket> {
  const t = await getTicket(app, id)
  // Someone else's ticket is indistinguishable from a missing one.
  if (t.requester.userId !== userId) throw notFound()
  return t
}

export async function getMyTicket(app: App, userId: string, id: string): Promise<LambdaResponse> {
  const t = await ownTicket(app, userId, id)
  return json(200, { ticket: forRequester(t), messages: await messages(app, id, false) })
}

export async function replyAsRequester(app: App, userId: string, event: LambdaEvent, id: string): Promise<LambdaResponse> {
  const t = await ownTicket(app, userId, id)
  if (t.status === 'closed') throw new HttpError(409, 'conflict', 'This request is closed. Open a new one.')
  const body = text(parseJsonBody<Record<string, unknown>>(event)['body'], 'body', 5000)
  await addMessage(app, id, { from: 'requester', author: t.requester.name || 'Member', body, internal: false })
  // A reply reopens a resolved ticket and puts it back with staff.
  const status: TicketStatus = t.status === 'resolved' || t.status === 'waiting' ? 'open' : t.status
  return json(200, { ticket: forRequester(await save(app, t, { status, lastFrom: 'requester' })) })
}

export async function closeAsRequester(app: App, userId: string, id: string): Promise<LambdaResponse> {
  const t = await ownTicket(app, userId, id)
  return json(200, { ticket: forRequester(await save(app, t, { status: 'closed' })) })
}

// ── Staff ─────────────────────────────────────────────────────────────────

export async function queue(app: App): Promise<LambdaResponse> {
  const tickets = (await app.store.query(DESK_PK, TICKET_PREFIX)) as Ticket[]
  tickets.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const counts = Object.fromEntries(STATUSES.map((s) => [s, tickets.filter((t) => t.status === s).length]))
  return json(200, { tickets: tickets.map(forStaff), counts })
}

export async function getForStaff(app: App, id: string): Promise<LambdaResponse> {
  const t = await getTicket(app, id)
  return json(200, { ticket: forStaff(t), messages: await messages(app, id, true) })
}

export async function replyAsStaff(app: App, actor: string, event: LambdaEvent, id: string): Promise<LambdaResponse> {
  const t = await getTicket(app, id)
  if (t.status === 'closed') throw new HttpError(409, 'conflict', 'This ticket is closed.')
  const raw = parseJsonBody<Record<string, unknown>>(event)
  const body = text(raw['body'], 'body', 5000)
  const internal = raw['internal'] === true
  const reg = await getRegistry(app, actor)
  await addMessage(app, id, { from: 'staff', author: reg?.label || 'Support', body, internal })
  if (internal) return json(200, { ticket: forStaff(await save(app, t, {})) })
  await tellRequester(app, t, `Re: ${t.subject}`, body)
  return json(200, { ticket: forStaff(await save(app, t, { status: t.status === 'resolved' ? 'resolved' : 'waiting', lastFrom: 'staff' })) })
}

export async function updateTicket(app: App, actor: string, event: LambdaEvent, id: string): Promise<LambdaResponse> {
  const t = await getTicket(app, id)
  const raw = parseJsonBody<Record<string, unknown>>(event)
  const patch: Partial<Ticket> = {}
  if (raw['status'] !== undefined) {
    if (!(STATUSES as readonly unknown[]).includes(raw['status'])) throw badRequest(`status must be one of: ${STATUSES.join(', ')}.`)
    patch.status = raw['status'] as TicketStatus
  }
  if (raw['priority'] !== undefined) {
    if (raw['priority'] !== 'normal' && raw['priority'] !== 'high') throw badRequest('priority must be normal or high.')
    patch.priority = raw['priority']
  }
  const clearAssignee = raw['assignee'] === null || raw['assignee'] === ''
  if (raw['assignee'] !== undefined && !clearAssignee) {
    if (!isValidId(raw['assignee'])) throw badRequest('assignee must be a user id.')
    patch.assignee = raw['assignee']
  }
  const next = await save(app, t, patch, { clearAssignee })
  if (patch.status && patch.status !== t.status) {
    await addMessage(app, id, { from: 'staff', author: 'Vault', body: `Status changed to ${patch.status.replace('_', ' ')}.`, internal: true })
    if (patch.status === 'resolved') await tellRequester(app, t, `Resolved: ${t.subject}`, 'Your request has been marked resolved. If anything is still wrong, reply and it will reopen.')
  }
  await audit(app, actor, 'desk.update', id, JSON.stringify(patch))
  return json(200, { ticket: forStaff(next) })
}

/** Approves an access request: issues an invitation, emails it to the
 *  requester when mail is set up, and resolves the ticket. */
export async function approveAccess(app: App, actor: string, actorRole: Role, event: LambdaEvent, id: string): Promise<LambdaResponse> {
  const t = await getTicket(app, id)
  if (t.kind !== 'access') throw badRequest('Only access requests can be approved.')
  if (t.status === 'closed') throw new HttpError(409, 'conflict', 'This ticket is closed.')
  const raw = parseJsonBody<Record<string, unknown>>(event)
  const role = raw['role'] === undefined ? 'user' : raw['role']
  if (role !== 'user' && !can(actorRole, 'roles.write')) throw forbidden()
  if (!['user', 'viewer', 'support', 'marketing', 'admin'].includes(role as string)) throw badRequest('Unknown role.')
  const label = t.requester.name || `Request #${t.number}`
  await audit(app, actor, 'desk.approve-access', id, label)
  const { code, invite } = await createInvite(app, actor, label, 7, role as string)
  let emailed = false
  if (t.requester.email && app.mailer) {
    const { inviteMessage } = await import('../mail.js')
    emailed = await notify(app.mailer, { to: t.requester.email, ...inviteMessage(app.config.origin, code, label, invite.expiresAt) })
  }
  await addMessage(app, id, { from: 'staff', author: 'Vault', body: emailed ? 'Approved. An invitation was emailed.' : 'Approved. An invitation code was issued to send to the requester.', internal: true })
  const next = await save(app, t, { status: 'resolved', lastFrom: 'staff' })
  return json(200, { ticket: forStaff(next), code, emailed })
}

/** Resets two-factor sign-in for the account behind a sign-in request.
 *  Staff must have verified the person through another channel first; the
 *  UI says so, and the action is audited. */
export async function resetTwoFactorFor(app: App, actor: string, actorRole: Role, id: string): Promise<LambdaResponse> {
  const t = await getTicket(app, id)
  if (t.kind !== 'signin') throw badRequest('Only sign-in requests can do this.')
  if (!t.requester.email) throw new HttpError(409, 'conflict', 'The requester address has been erased.')
  const pointer = await app.store.get(emailPk(emailDigest(t.requester.email, app.config.pepper)), EMAIL_SK)
  if (!pointer) throw new HttpError(404, 'not_found', 'No account uses that address.')
  const userId = String(pointer['userId'])
  const profile = await app.store.get(userPk(userId), PROFILE_SK)
  if (!profile) throw notFound()
  // The same rank rule as the admin panel: an admin can reset a member's or
  // a support agent's two-factor, never an owner's or another admin's.
  if (userId === actor) throw badRequest('That cannot be done to your own account.')
  if (!outranks(actorRole, await roleOf(app, userId))) throw forbidden()
  await audit(app, actor, 'desk.reset-2fa', userId, `ticket #${t.number}`)
  const { totp: _t, recoveryCodes: _r, pendingTotp: _p, ...rest } = profile
  await app.store.put(rest as typeof profile)
  await addMessage(app, id, { from: 'staff', author: 'Vault', body: 'Two-factor sign-in was reset for the account.', internal: true })
  await tellRequester(app, t, 'Two-factor sign-in was reset', 'Two-factor sign-in has been turned off for your account. Sign in with your master password, then turn two-factor sign-in on again in Settings with your new phone.')
  const next = await save(app, t, { status: 'resolved', lastFrom: 'staff' })
  return json(200, { ticket: forStaff(next), hadTwoFactor: !!profile['totp'] })
}

/** Closes tickets resolved more than a week ago, which erases their addresses. */
export async function closeStaleTickets(app: App): Promise<number> {
  const cutoff = app.now() - AUTO_CLOSE_DAYS * 86_400_000
  const stale = ((await app.store.query(DESK_PK, TICKET_PREFIX)) as Ticket[])
    .filter((t) => t.status === 'resolved' && Date.parse(t.updatedAt) < cutoff)
  for (const t of stale) await save(app, t, { status: 'closed' })
  return stale.length
}

export async function openTicketCount(app: App): Promise<number> {
  return ((await app.store.query(DESK_PK, TICKET_PREFIX)) as Ticket[]).filter((t) => t.status === 'open' || t.status === 'in_progress').length
}
