# 0004 — The access token header

Status: Accepted
Date: 2026-09-22

## Context

The API reads its access token from `x-vault-auth` rather than from `Authorization`. That
is unconventional enough that someone will eventually try to correct it, so the reasoning
belongs somewhere durable.

The original reason no longer applies. On the first deployment the API sat behind a
CloudFront Origin Access Control, which had to fill `Authorization` with its own SigV4
signature, leaving the header unavailable to carry anything else. That deployment is gone
([0003](0003-running-everything-on-oci.md)). The header could now be `Authorization` with
no infrastructure objection at all.

It is staying as it is, for a smaller but real reason.

## Decision

**The access token travels in `x-vault-auth`, formatted as `Bearer <token>`.** The API
reads only that header. A token presented in `Authorization` is ignored and the request is
rejected as unauthenticated, and a test asserts this.

**A cross-origin form cannot set a custom header.** It can cause a cookie to be attached
to a request it triggers, and it can submit to any URL, but it cannot add
`x-vault-auth`. So the token cannot be replayed by a cross-site request, and the API needs
no separate cross-site request forgery defence — not a token, not a `SameSite` policy, not
an origin check.

That is a small benefit. It is also free, already implemented, already tested, and the
alternative is churn in the most security-sensitive path in the product for the sake of
convention.

## Rejected

**Moving to `Authorization` now that nothing forces the change.** More conventional, and
any HTTP client would set it without being told. It would also mean re-examining cross-site
request forgery, which the current arrangement makes moot by construction.

**Accepting both headers.** Every client would work, including ones written by mistake. It
would also mean the CSRF property holds only for clients that happen to use the custom
header, which is a property that is true until someone relies on it.

**Carrying the token in a cookie.** The browser would attach it automatically, which is
convenient and is exactly the behaviour that makes cross-site request forgery possible.

## Consequences

**Every client must send `x-vault-auth`.** The web client, the planned Android client, and
anything used to test by hand. A request that looks correct and carries `Authorization`
is rejected as unauthenticated, which is confusing exactly once.

**There is no CSRF defence in the API**, because there is nothing for it to defend
against. If the token ever moves to a cookie or `Authorization` is ever accepted, that
stops being true and a defence has to be added in the same change.
