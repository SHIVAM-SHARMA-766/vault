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

/** Every error code the API returns, and what it means. Clients branch on the
 *  code, never on the message; the OpenAPI document lists these. Adding a code
 *  means adding it here, which the type below enforces. */
export const ERROR_CODES = {
  bad_request: 'The request is malformed or a field is invalid; `details` may say which.',
  invalid_content: 'Website content failed validation; `details` lists each field.',
  unauthorized: 'No valid access token.',
  invalid_credentials: 'Sign-in failed. Deliberately does not say why.',
  two_factor_required: 'The password was right; a TOTP or recovery code is needed too.',
  invalid_two_factor: 'The TOTP or recovery code is wrong or already used.',
  forbidden: 'Signed in, but not permitted (role, disabled account, closed registration).',
  network_not_allowed: 'The server\'s sign-in allow-list does not include this address.',
  account_password_required: 'This account signs in with its account password first (decisions/0036); the master password alone is not enough.',
  sso_required: 'This server requires single sign-on (decisions/0021): sign in with the identity provider first and send its ticket.',
  sso_invalid: 'The single sign-on ticket is unknown, expired, used, or for another account.',
  not_found: 'No such route or item.',
  conflict: 'The item already exists, or the change conflicts with the current state.',
  too_large: 'The body or a stored item exceeds its size limit.',
  rate_limited: 'Too many requests; wait `retry-after` seconds.',
  unavailable: 'The feature is not configured on this server.',
  not_in_edition: 'This server\'s edition (personal, business, hosted) does not include the feature (decisions/0030).',
  policy_required: 'An organization policy is not met (two-factor sign-in, or master password strength); `message` says which.',
  internal: 'An unexpected error. Quote `requestId` when reporting it.',
} as const

export type ErrorCode = keyof typeof ERROR_CODES

/** A failure that is safe to report to the caller. Anything else becomes a 500
 *  with no detail, because an unexpected error's message may describe internal
 *  state. */
export class HttpError extends Error {
  readonly status: number
  readonly code: ErrorCode
  /** Seconds, for 429 responses. */
  readonly retryAfter: number | undefined
  /** Field-level problems, for a 400 the caller can show next to each field. */
  details: unknown

  constructor(status: number, code: ErrorCode, message: string, retryAfter?: number) {
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

/** A redirect, for the single sign-on round trip through the browser. */
export function redirect(location: string): LambdaResponse {
  return { statusCode: 302, headers: { ...BASE_HEADERS, location }, body: '' }
}

export function json(status: number, body: unknown, extra: Record<string, string> = {}): LambdaResponse {
  return {
    statusCode: status,
    headers: { ...BASE_HEADERS, ...extra },
    body: JSON.stringify(body),
  }
}

export function errorResponse(err: unknown, requestId?: string): LambdaResponse {
  const id = requestId ? { requestId } : {}
  if (err instanceof HttpError) {
    const extra = err.retryAfter === undefined ? {} : { 'retry-after': String(err.retryAfter) }
    return json(err.status, { error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}), ...id }, extra)
  }
  // Unexpected. The detail goes to the log, never to the caller; the request
  // id ties the two together.
  console.error(JSON.stringify({ level: 'error', requestId, message: 'unhandled error', error: err instanceof Error ? err.stack ?? err.message : String(err) }))
  return json(500, { error: 'internal', message: 'Internal error.', ...id })
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
