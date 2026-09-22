# 0004 — The access token header

Status: Accepted
Date: 2026-09-22

## Context

The API reads its access token from `x-vault-auth`, not from `Authorization`. That looks
like a mistake, and a future change will eventually try to correct it. This records why
it must not be corrected.

The API runs as a Lambda Function URL whose authorization type is `AWS_IAM`, reachable
only through CloudFront, which signs each request with an Origin Access Control
([0003](0003-where-infrastructure-is-defined.md), and A3/A4 in
[docs/threat-model.md](../docs/threat-model.md)). SigV4 puts that signature in the
**`Authorization` header**. It is not available to carry anything else.

CloudFront decides what reaches an origin through an origin request policy. The managed
`AllViewerExceptHostHeader` policy is the usual choice for a Function URL origin and
forwards every viewer header except `Host` — `Authorization` included. Declaring
`Authorization` as forwarded means CloudFront passes the viewer's value rather than
setting its own signature, so an unsigned request arrives at an IAM-protected Function
URL.

**The resulting failure is silent and misleading.** The Function URL answers `403
Forbidden` without invoking the function: no log stream, no invocation metric, nothing in
CloudWatch. A 403 from an endpoint that is supposed to be locked down looks exactly like
the access control working. This was diagnosed against the live distribution only after
confirming the function itself answered correctly when the same URL was called with a
hand-computed SigV4 signature.

## Decision

**The access token travels in `x-vault-auth`, formatted as `Bearer <token>`.**

The origin request policy for `/api/*` forwards all viewer headers except `Host` and
`Authorization`, leaving CloudFront free to populate the latter with its signature.

The API reads only `x-vault-auth`. A token presented in `Authorization` is ignored and
the request is rejected as unauthenticated, and a test asserts this. Accepting both would
work in development, fail in production for reasons no error message explains, and hide
the regression if the origin request policy were ever changed back.

## Rejected

**Keeping `Authorization` and dropping the Origin Access Control.** The Function URL would
have to be publicly reachable, which removes the control that makes CloudFront the only
entry point — and with it the guarantee that every request has passed the
Content-Security-Policy and the security headers. Trading a real access control for a
conventional header name is the wrong way round.

**Carrying the token in a cookie.** Workable, and it survives the same constraint. It
also introduces cross-site request forgery as a concern, which a custom header does not:
a cross-origin form can cause a cookie to be sent but cannot set a custom header. Adding
a CSRF defence to get a more familiar mechanism is a poor trade.

**Accepting both headers.** See above — it converts a loud failure into a silent one.

## Consequences

**Every client must send `x-vault-auth`.** The web client, the planned Android client,
and anything used to test by hand. A request that looks correct and carries
`Authorization` will be rejected as unauthenticated, which is confusing exactly once.

**A custom header cannot be set by a cross-origin form**, so the token is not replayable
through a cross-site request the way a cookie would be. This was not the reason for the
choice, but it is a real benefit.

**The origin request policy is load-bearing.** If it is ever replaced with
`AllViewerExceptHostHeader`, the API stops working with a 403 that names nothing and
leaves no log. The policy carries a comment saying so, and this record is the other half
of that warning.
