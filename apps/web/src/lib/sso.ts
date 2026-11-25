// Single sign-on (decisions/0021). The server sends the browser back to
// /app/#sso=<ticket> or /app/#sso-error=<code>. The fragment is read once and
// removed from the address bar at once, so a ticket is not left in history.

export interface SsoReturn { ticket?: string; error?: string }

let taken: SsoReturn | null = null

export function takeSsoReturn(): SsoReturn {
  if (taken) return taken
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''))
  taken = { ...(hash.get('sso') ? { ticket: hash.get('sso')! } : {}), ...(hash.get('sso-error') ? { error: hash.get('sso-error')! } : {}) }
  if (taken.ticket || taken.error) history.replaceState(null, '', location.pathname + location.search)
  return taken
}

/** Tests and a second attempt: forget what was read. */
export function forgetSsoReturn(): void { taken = { } }

const MESSAGES: Record<string, string> = {
  cancelled: 'Single sign-on was cancelled.',
  expired: 'That sign-in took too long. Try again.',
  no_account: 'Your identity provider signed you in, but there is no Vault account for that address on this server. Ask for an invitation.',
  unverified_email: 'Your identity provider has not verified your email address.',
  no_email: 'Your identity provider did not share your email address with Vault. Ask your administrator to allow the "email" scope.',
  bad_token: 'Your identity provider\'s answer could not be verified, so you were not signed in. Tell your administrator.',
  exchange_failed: 'Your identity provider refused the sign-in. Try again, or tell your administrator.',
  provider_unavailable: 'Your identity provider could not be reached. Try again in a moment.',
  provider_misconfigured: 'Single sign-on is not set up correctly on this server. Tell your administrator.',
  provider_error: 'Your identity provider reported an error. Try again.',
}

export const ssoErrorMessage = (code: string) => MESSAGES[code] ?? 'Single sign-on did not complete. Try again.'
