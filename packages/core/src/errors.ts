// What a person reads when a request fails: what happened, in plain words,
// and what to do next. The server's own message is kept when it already says
// something useful (a 400 explaining which field is wrong, a 409 explaining
// the conflict); generic faults are replaced.

export interface Failure {
  status: number
  /** The server's error code, or 'network' / 'malformed' from the client. */
  code: string
  message: string
  /** Seconds, from Retry-After. */
  retryAfter?: number | undefined
  /** The server's request id, for a fault the operator can look up. */
  requestId?: string | undefined
}

function waitFor(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return 'a few minutes'
  if (seconds < 60) return `${Math.ceil(seconds)} seconds`
  const m = Math.ceil(seconds / 60)
  return m === 1 ? 'a minute' : `${m} minutes`
}

export function friendlyError(f: Failure): string {
  if (f.code === 'network' || f.status === 0) {
    return 'Could not reach the server. Check your internet connection, then try again.'
  }
  if (f.code === 'malformed' || f.status === 502 || f.status === 503 || f.status === 504) {
    return 'The server is not answering properly — it may be restarting or updating. Try again in a minute.'
  }
  if (f.status === 429) return `Too many attempts. Wait ${waitFor(f.retryAfter)}, then try again.`
  if (f.status === 413) return f.message && !/^request body/i.test(f.message) ? f.message : 'That is too large to save.'
  if (f.status >= 500) {
    return `Something went wrong on the server, and nothing was changed.${f.requestId ? ` (reference ${f.requestId.slice(0, 8)})` : ''} Try again; if it keeps happening, tell the people who run this server.`
  }
  if (f.status === 401 && f.code === 'unauthorized') return 'Your session has ended. Sign in again.'
  if (f.status === 403 && f.code === 'forbidden' && /^not permitted\.?$/i.test(f.message)) return 'Your account is not allowed to do that. Ask an admin if you need it.'
  if (f.status === 404 && /^not found\.?$/i.test(f.message)) return 'That no longer exists — it may have been deleted on another device. Refresh to see the latest.'
  return f.message || 'Something went wrong. Try again.'
}
