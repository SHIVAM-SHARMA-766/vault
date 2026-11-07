// Uploading to any S3-compatible object store — AWS S3, MinIO, Cloudflare R2,
// Backblaze B2, OCI's S3 compatibility endpoint — with AWS Signature V4,
// path-style URLs, and nothing but node:crypto and fetch. One operation is
// needed (PUT an object), which does not justify an SDK of several megabytes.

import { createHash, createHmac } from 'node:crypto'

export interface S3Target {
  /** e.g. https://s3.eu-central-1.amazonaws.com, https://<account>.r2.cloudflarestorage.com, http://minio:9000 */
  endpoint: string
  region: string
  bucket: string
  accessKey: string
  secretKey: string
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest()
/** RFC 3986 encoding of one path segment, as SigV4 requires. */
const encodeSegment = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

/** The headers for a signed request. Exported for its known-answer test. */
export function signV4(t: S3Target, method: string, url: URL, payloadHash: string, extra: Record<string, string>, now: Date): Record<string, string> {
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const date = amzDate.slice(0, 8)
  const headers: Record<string, string> = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, ...extra }
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort()
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v.trim()]))
  const canonical = [method, url.pathname, url.search.slice(1), names.map((n) => `${n}:${lower[n]}\n`).join(''), names.join(';'), payloadHash].join('\n')
  const scope = `${date}/${t.region}/s3/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n')
  const key = hmac(hmac(hmac(hmac(`AWS4${t.secretKey}`, date), t.region), 's3'), 'aws4_request')
  const signature = createHmac('sha256', key).update(toSign).digest('hex')
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${t.accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` }
}

export async function s3Put(t: S3Target, key: string, body: Buffer, contentType = 'application/octet-stream'): Promise<void> {
  const url = new URL(`${t.endpoint.replace(/\/+$/, '')}/${encodeSegment(t.bucket)}/${key.split('/').map(encodeSegment).join('/')}`)
  const headers = signV4(t, 'PUT', url, sha256(body), { 'content-type': contentType }, new Date())
  const { host: _host, ...send } = headers
  const res = await fetch(url, { method: 'PUT', headers: send, body, signal: AbortSignal.timeout(120_000) })
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300)
    throw new Error(`S3 upload failed: ${res.status} ${text.match(/<Code>([^<]+)<\/Code>/)?.[1] ?? text}`)
  }
}
