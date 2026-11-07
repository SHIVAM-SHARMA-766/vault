// Outbound requests to addresses a person typed — their S3 bucket, their
// WebDAV folder — for personal backups (decisions/0017).
//
// Left unguarded, "back up to https://169.254.169.254/" or to the database's
// own port would make the server a probe of its own network (SSRF). So:
//
//   - https only, unless the operator allows private destinations, in which
//     case http is accepted too (a NAS on the LAN rarely has a certificate);
//   - the host is resolved by our own lookup, and the connection is made to
//     the address that lookup approved — no second resolution an attacker's
//     DNS could answer differently (rebinding);
//   - loopback, private, link-local, CGNAT, multicast and reserved addresses
//     are refused unless the operator allowed private destinations;
//   - redirects are never followed, and responses are size-capped.

import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'

export class EgressRefused extends Error {}

// Two lists: a BlockList checks IPv4 addresses against IPv6 rules as mapped
// addresses, so one shared list holding ::ffff:0:0/96 would block every IPv4.
const blocked4 = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked4.addSubnet(net, prefix, 'ipv4')
const blocked6 = new BlockList()
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) blocked6.addSubnet(net, prefix, 'ipv6')

/** The IPv4 address inside an IPv4-mapped IPv6 address (::ffff:a.b.c.d, in
 *  either spelling), or null. */
function mappedV4(address: string): string | null {
  let host: string
  try { host = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase() } catch { return null }
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host)
  if (!m) return null
  const hi = parseInt(m[1]!, 16), lo = parseInt(m[2]!, 16)
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
}

/** Whether an address is one a person's backup must never reach. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return blocked4.check(address, 'ipv4')
  if (family === 6) {
    const v4 = mappedV4(address)
    if (v4) return blocked4.check(v4, 'ipv4')
    return blocked6.check(address, 'ipv6')
  }
  return true
}

export interface EgressOptions {
  allowPrivate: boolean
  method?: string
  headers?: Record<string, string>
  body?: Buffer
  timeoutMs?: number
  maxResponseBytes?: number
}

export interface EgressResponse {
  status: number
  headers: IncomingHttpHeaders
  body: Buffer
}

/** Checks a destination URL before anything is stored or sent. */
export function checkDestinationUrl(raw: string, allowPrivate: boolean): URL {
  let url: URL
  try { url = new URL(raw) } catch { throw new EgressRefused('That is not a valid address.') }
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) {
    throw new EgressRefused('The address must start with https://.')
  }
  if (url.username || url.password) throw new EgressRefused('Put the user name and password in their own fields, not in the address.')
  if (!allowPrivate && isIP(url.hostname.replace(/^\[|\]$/g, '')) && isBlockedAddress(url.hostname.replace(/^\[|\]$/g, ''))) {
    throw new EgressRefused('That address is on a private or reserved network.')
  }
  return url
}

export function guardedRequest(raw: string, opts: EgressOptions): Promise<EgressResponse> {
  const url = checkDestinationUrl(raw, opts.allowPrivate)
  const lookup = (hostname: string, options: object, cb: (err: Error | null, address: string | LookupAddress[], family?: number) => void) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
      if (err) return cb(err, '')
      const allowed = opts.allowPrivate ? addresses : addresses.filter((a) => !isBlockedAddress(a.address))
      if (!allowed.length) return cb(new EgressRefused(`${hostname} resolves to a private or reserved address.`), '')
      const wantsAll = (options as { all?: boolean }).all
      if (wantsAll) return cb(null, allowed)
      cb(null, allowed[0]!.address, allowed[0]!.family)
    })
  }
  const max = opts.maxResponseBytes ?? 64 * 1024 * 1024
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const req = send(url, {
      method: opts.method ?? 'GET',
      headers: { ...(opts.headers ?? {}), ...(opts.body ? { 'content-length': String(opts.body.length) } : {}) },
      lookup: lookup as never,
      timeout: opts.timeoutMs ?? 120_000,
    }, (res) => {
      const chunks: Buffer[] = []
      let size = 0
      let over = false
      res.on('data', (c: Buffer) => {
        if (over) return
        size += c.length
        if (size > max) { over = true; reject(new EgressRefused('The response is too large.')); req.destroy(); return }
        chunks.push(c)
      })
      res.on('end', () => { if (!over) resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }) })
      res.on('error', (e) => { if (!over) reject(e) })
    })
    req.on('timeout', () => req.destroy(new Error('The destination did not answer in time.')))
    req.on('error', (e) => reject(e))
    if (opts.body) req.end(opts.body)
    else req.end()
  })
}
