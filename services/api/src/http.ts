// Request and response shapes for a Lambda Function URL, plus the error type
// every route throws.
//
// The event format is API Gateway payload 2.0, which is what a Function URL
// delivers. The few fields used are declared here rather than pulled from a
// types package, so the service depends on nothing it does not call.

export interface LambdaEvent {
  rawPath: string
  rawQueryString?: string
  headers: Record<string, string | undefined>
  body?: string
  isBase64Encoded?: boolean
  requestContext: {
    http: {
      method: string
      sourceIp: string
      userAgent?: string
    }
  }
}

export interface LambdaResponse {
  statusCode: number
  headers: Record<string, string>
  body: string
}

/** A failure that is safe to report to the caller. Anything else becomes a 500
 *  with no detail, because an unexpected error's message may describe internal
 *  state. */
export class HttpError extends Error {
  readonly status: number
  readonly code: string
  /** Seconds, for 429 responses. */
  readonly retryAfter: number | undefined

  constructor(status: number, code: string, message: string, retryAfter?: number) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
    this.retryAfter = retryAfter
  }
}

export const badRequest = (message: string) => new HttpError(400, 'bad_request', message)
export const unauthorized = () => new HttpError(401, 'unauthorized', 'Not authenticated.')
export const forbidden = () => new HttpError(403, 'forbidden', 'Not permitted.')
export const notFound = () => new HttpError(404, 'not_found', 'Not found.')
export const conflict = (message: string) => new HttpError(409, 'conflict', message)
export const tooLarge = (message: string) => new HttpError(413, 'too_large', message)
export const tooManyRequests = (retryAfter: number) =>
  new HttpError(429, 'rate_limited', 'Too many attempts. Try again later.', retryAfter)

/** Every authentication failure, whatever its cause — unknown address, wrong
 *  auth key, malformed input. A caller must not be able to tell which, or the
 *  endpoint becomes a way to discover whether an address is registered.
 *  See docs/threat-model.md, A7. */
export const invalidCredentials = () =>
  new HttpError(401, 'invalid_credentials', 'Invalid credentials.')

const BASE_HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  // Belt and braces: CloudFront sets these too, but the function is the thing
  // that must not be embeddable or sniffable if it is ever reached directly.
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
}

export function json(status: number, body: unknown, extra: Record<string, string> = {}): LambdaResponse {
  return {
    statusCode: status,
    headers: { ...BASE_HEADERS, ...extra },
    body: JSON.stringify(body),
  }
}

export function errorResponse(err: unknown): LambdaResponse {
  if (err instanceof HttpError) {
    const extra = err.retryAfter === undefined ? {} : { 'retry-after': String(err.retryAfter) }
    return json(err.status, { error: err.code, message: err.message }, extra)
  }
  // Unexpected. The detail goes to the log, never to the caller.
  console.error('unhandled error', err)
  return json(500, { error: 'internal', message: 'Internal error.' })
}

export function parseJsonBody<T>(event: LambdaEvent): T {
  if (!event.body) throw badRequest('A JSON body is required.')
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw badRequest('The body must be a JSON object.')
    }
    return parsed as T
  } catch (err) {
    if (err instanceof HttpError) throw err
    throw badRequest('The body is not valid JSON.')
  }
}
