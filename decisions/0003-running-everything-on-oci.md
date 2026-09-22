# 0003 — Running everything on one provider

Status: Accepted
Date: 2026-09-22

## Context

This project was first built for AWS: a Lambda behind a Function URL, DynamoDB, and
CloudFront in front of an S3 bucket. That version was fully written, tested, and applied —
twenty-three resources, a deployed API, verified security headers — and then it could not
be reached.

CloudFront could not invoke the Function URL. Every request returned 403 from the URL's
authorization layer, with zero invocations and no log stream. The cause was not
configuration. Six variants were tried, including a distribution and a function created
from scratch for the test, with and without an origin request policy. All returned 403.
Meanwhile a Function URL configured with `auth-type NONE` and a wildcard principal — the
arrangement AWS documents for a public URL, involving neither CloudFront nor any
signature — was refused as well, while the same URL under `AWS_IAM` answered a
hand-signed request normally.

So the account permitted Function URL invocation by an IAM identity and refused it for
both public callers and the CloudFront service principal. It also reported a Lambda
concurrency limit of 10 against a default of 1,000, which is what an account still under
new-account restrictions looks like.

That left three options: wait on a support case with no committed timeline, front the
function with an API Gateway whose free tier expires after twelve months, or move.

## Decision

**Everything runs on OCI: one always-free instance, one NoSQL table, one Object Storage
bucket. No AWS, no second provider, no CDN.**

```
Browser ──► Caddy on one instance
              ├── /       → the built client, from disk
              └── /api/*  → the API, on localhost → NoSQL
                                                  → Object Storage (exports)
```

Caddy terminates TLS with a certificate it obtains itself, serves the client, sets every
security header, and proxies the API. The client and the API share an origin without
anything sitting in front of them, which is what lets the Content-Security-Policy say
`connect-src 'self'`.

The hostname is a free dynamic-DNS name. There is no purchased domain.

### What this costs, and what it does not

Nothing. Not "a few cents" — the instance, the table, the bucket, and the certificate are
all within perpetual free allowances, and the previous design's one billed line was S3.

### Why not keep the static client on S3 and CloudFront

That was considered seriously, because CloudFront's certificate is issued for a name AWS
controls, which is a stronger trust anchor than a free dynamic-DNS name. Two things
decided against it.

Object Storage on OCI cannot replace it: it permits exactly two response headers,
`Content-Disposition` and `Cache-Control`, so it cannot carry a Content-Security-Policy.
Serving the client from a bucket is therefore not an option on this provider, and Caddy
has to do it — at which point CloudFront is in front of something that no longer needs it.

And the resilience argument for spreading across providers had already collapsed. Once
the API and the data are on OCI, the vault is down if OCI is down, whether or not the
static files sit somewhere else.

## Rejected

**Waiting for AWS.** A free support case was drafted and could still be filed. Rejected as
the primary path because it has no committed timeline and the work to move is small: the
data model carried over nearly unchanged, and the storage layer was already behind a
five-method interface.

**API Gateway in front of the function.** Works immediately and needs nobody's permission.
Its free tier lasts twelve months rather than forever, after which a single-user vault
costs on the order of a cent a month. Rejected because the cost target is zero and a
recurring charge, however small, is a decision that should be taken deliberately rather
than as a workaround.

**Running on the instance that hosts the automation runner.** That host holds credentials
for everything it automates. Putting a public API on it would trade away the largest
single security win available. A second always-free instance existed, doing nothing but
retrying an Ampere launch that never succeeded, and it was repurposed instead.

**Buying a domain**, roughly ₹800 a year. It would replace the dynamic-DNS name with one
controlled at a registrar, which removes the accepted risk described below. Declined for
now; it remains the single cheapest security improvement available to this project.

## Consequences

**The dynamic-DNS name is the whole user-facing trust path.** Whoever controls it can
obtain a certificate for it and serve their own JavaScript to the browser. That is A3 in
[the threat model](../docs/threat-model.md), the highest-severity threat, and unlike a
compromise of the server it is **not** bounded by the key hierarchy: modified client code
sees the master password. This is accepted knowingly, and it is the reason buying a domain
stays on the table.

**One instance is a single point of failure, and it can be reclaimed.** Oracle may reclaim
an always-free instance whose CPU, network *and* memory stay below 20% for seven days. A
single-user vault is idle almost all the time. The data survives in NoSQL either way, but
the service does not. See [the runbook](../docs/runbook.md) for what to measure and what
to do about it.

**There is a host to patch.** Unattended upgrades are enabled; that is not the same as
nobody being responsible for it.

**No CDN in front.** A single user does not need one, but nothing absorbs a flood either.
The API's own rate limiting and the table's provisioned ceiling are what remain.

**What did not change:** the cryptography, the key hierarchy, the data model's shape, the
client, and the test suite. Moving providers changed one storage adapter and added an HTTP
wrapper. That is the strongest evidence that the design was not built around a vendor.
