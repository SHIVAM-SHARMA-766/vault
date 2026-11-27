// Hosted tenants, run by the operator (admin console phase 4).
//
//   PUT    /api/admin/orgs/:org                     seat limit, suspend / resume
//   POST   /api/admin/orgs/:org/domains             claim a domain: a TXT token
//   POST   /api/admin/orgs/:org/domains/:d/verify   look the token up in DNS
//   DELETE /api/admin/orgs/:org/domains/:d          let it go
//
// A verified domain is one company's: a person who signs up with an address
// at it and asks for a vault is approved at once (decisions/0037), and the
// company's page shows who they are, to invite. Joining the company itself
// still takes an invitation and a fingerprint check: the server cannot give
// anyone the company's keys.

import { randomBytes } from 'node:crypto'
import { resolveTxt } from 'node:dns/promises'

import type { App } from '../context.js'
import { HttpError, type LambdaEvent, type LambdaResponse, badRequest, conflict, json, notFound, parseJsonBody } from '../http.js'
import { SYSTEM_PK, isValidId } from '../keys.js'
import { audit, listRegistry } from '../system.js'
import { alertStaff, emailOf } from './admin.js'
import { seatsUsed } from './orgs.js'

const orgPk = (id: string) => `ORG#${id}`
const domainSk = (d: string) => `DOMAIN#${d}`
const DOMAIN_RE = /^(?=.{4,253}$)(?!-)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/
const TXT_NAME = (d: string) => `_vault-verify.${d}`

interface Domain { domain: string; token: string; claimedAt: string; verifiedAt?: string }

/** How DNS is asked; tests replace it. */
let txt: (name: string) => Promise<string[][]> = resolveTxt
export function setTxtResolver(fn: (name: string) => Promise<string[][]>): void { txt = fn }

async function tenant(app: App, orgId: string) {
  if (!isValidId(orgId)) throw notFound()
  const meta = await app.store.get(orgPk(orgId), 'META')
  if (!meta || meta['kind'] === 'direct') throw notFound()
  return meta
}

const domainsOf = (meta: Record<string, unknown>) => (Array.isArray(meta['domains']) ? meta['domains'] as Domain[] : [])

export async function updateTenant(app: App, actor: string, orgId: string, event: LambdaEvent): Promise<LambdaResponse> {
  const meta = await tenant(app, orgId)
  const b = parseJsonBody<{ seatLimit?: unknown; suspended?: unknown }>(event)
  const next = { ...meta }
  if (b.seatLimit !== undefined) {
    if (b.seatLimit !== null && (typeof b.seatLimit !== 'number' || !Number.isInteger(b.seatLimit) || b.seatLimit < 1 || b.seatLimit > 100_000)) {
      throw badRequest('seatLimit must be a whole number from 1 to 100000, or null for no limit.')
    }
    if (b.seatLimit === null) delete next['seatLimit']
    else next['seatLimit'] = b.seatLimit
    await audit(app, actor, 'org.seats', orgId, b.seatLimit === null ? 'no limit' : String(b.seatLimit))
  }
  if (b.suspended !== undefined) {
    if (typeof b.suspended !== 'boolean') throw badRequest('suspended must be true or false.')
    if (b.suspended) next['suspended'] = true
    else delete next['suspended']
    if ((meta['suspended'] === true) !== b.suspended) {
      await audit(app, actor, b.suspended ? 'org.suspend' : 'org.resume', orgId, String(meta['hint'] ?? ''))
      void alertStaff(app, actor, `${b.suspended ? 'suspended' : 'resumed'} the company ${String(meta['hint'] ?? '') || orgId}`)
    }
  }
  await app.store.put(next as typeof meta)
  return json(200, { ok: true, seatsUsed: await seatsUsed(app, orgId), seatLimit: typeof next['seatLimit'] === 'number' ? next['seatLimit'] : null, suspended: next['suspended'] === true })
}

export async function claimDomain(app: App, actor: string, orgId: string, event: LambdaEvent): Promise<LambdaResponse> {
  const meta = await tenant(app, orgId)
  const raw = parseJsonBody<{ domain?: unknown }>(event).domain
  const domain = typeof raw === 'string' ? raw.trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '') : ''
  if (!DOMAIN_RE.test(domain)) throw badRequest('domain must be a domain name, such as acme.com.')
  const list = domainsOf(meta)
  if (list.length >= 10) throw badRequest('A company has at most 10 domains.')
  const owner = await app.store.get(SYSTEM_PK, domainSk(domain))
  if (owner && owner['orgId'] !== orgId) throw conflict('Another company on this server has verified that domain.')
  const existing = list.find((d) => d.domain === domain)
  if (existing) return json(200, { domain: existing, record: { name: TXT_NAME(domain), value: `vault-verify=${existing.token}` } })
  const d: Domain = { domain, token: randomBytes(16).toString('hex'), claimedAt: new Date(app.now()).toISOString() }
  await app.store.put({ ...meta, domains: [...list, d] } as typeof meta)
  await audit(app, actor, 'org.domain-claim', orgId, domain)
  return json(201, { domain: d, record: { name: TXT_NAME(domain), value: `vault-verify=${d.token}` } })
}

export async function verifyDomain(app: App, actor: string, orgId: string, domain: string): Promise<LambdaResponse> {
  const meta = await tenant(app, orgId)
  const list = domainsOf(meta)
  const d = list.find((x) => x.domain === domain)
  if (!d) throw notFound()
  let records: string[][] = []
  try { records = await txt(TXT_NAME(domain)) } catch { /* not there yet */ }
  if (!records.some((r) => r.join('') === `vault-verify=${d.token}`)) {
    throw new HttpError(400, 'bad_request', `No TXT record ${TXT_NAME(domain)} with the value vault-verify=${d.token} was found yet. DNS changes can take a while to appear.`)
  }
  try {
    await app.store.put({ pk: SYSTEM_PK, sk: domainSk(domain), orgId, verifiedAt: new Date(app.now()).toISOString() }, { mustNotExist: true })
  } catch {
    const owner = await app.store.get(SYSTEM_PK, domainSk(domain))
    if (owner?.['orgId'] !== orgId) throw conflict('Another company on this server has verified that domain.')
  }
  const verified = { ...d, verifiedAt: new Date(app.now()).toISOString() }
  await app.store.put({ ...meta, domains: list.map((x) => (x.domain === domain ? verified : x)) } as typeof meta)
  await audit(app, actor, 'org.domain-verify', orgId, domain)
  return json(200, { domain: verified })
}

export async function releaseDomain(app: App, actor: string, orgId: string, domain: string): Promise<LambdaResponse> {
  const meta = await tenant(app, orgId)
  const list = domainsOf(meta)
  if (!list.some((d) => d.domain === domain)) throw notFound()
  await app.store.put({ ...meta, domains: list.filter((d) => d.domain !== domain) } as typeof meta)
  const owner = await app.store.get(SYSTEM_PK, domainSk(domain))
  if (owner?.['orgId'] === orgId) await app.store.delete(SYSTEM_PK, domainSk(domain))
  await audit(app, actor, 'org.domain-release', orgId, domain)
  return json(200, { ok: true })
}

/** The company that verified this address's domain, if any. */
export async function companyForEmail(app: App, email: string): Promise<string | null> {
  const domain = email.split('@')[1]?.toLowerCase()
  if (!domain) return null
  const row = await app.store.get(SYSTEM_PK, domainSk(domain))
  return row ? String(row['orgId']) : null
}

/** One company, for its page in the console: seats, domains, and accounts
 *  at its verified domains that are not in it yet (to invite). */
export async function getTenant(app: App, orgId: string): Promise<LambdaResponse> {
  const meta = await tenant(app, orgId)
  const rows = await app.store.query(orgPk(orgId))
  const memberIds = new Set(rows.filter((r) => r.sk.startsWith('MEMBER#')).map((r) => String(r['userId'])))
  const verified = domainsOf(meta).filter((d) => d.verifiedAt).map((d) => d.domain)
  const atDomains: { userId: string; email: string }[] = []
  if (verified.length) {
    for (const r of await listRegistry(app)) {
      const email = emailOf(app, r)
      if (!email || memberIds.has(r.userId)) continue
      if (verified.includes(email.split('@')[1]!.toLowerCase())) atDomains.push({ userId: r.userId, email })
    }
  }
  return json(200, {
    id: orgId, hint: String(meta['hint'] ?? ''), createdAt: meta['createdAt'] ?? null,
    seatsUsed: await seatsUsed(app, orgId),
    seatLimit: typeof meta['seatLimit'] === 'number' ? meta['seatLimit'] : null,
    suspended: meta['suspended'] === true,
    domains: domainsOf(meta).map((d) => ({ ...d, record: { name: TXT_NAME(d.domain), value: `vault-verify=${d.token}` } })),
    atDomains: atDomains.slice(0, 200),
  })
}
