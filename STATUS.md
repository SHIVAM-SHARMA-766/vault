# Status

What is in flight. Updated when something starts, stalls, or finishes.

Last updated: 2026-09-22

## Right now

**The stack is applied and the API is deployed, but the browser cannot reach the API.**
CloudFront cannot invoke the Lambda Function URL, and the cause is outside this project's
configuration.

Working and verified against the live system:

- The client path. CloudFront serves the private S3 bucket through an Origin Access
  Control; a client-side route such as `/vault/settings` returns the shell with 200 while
  a missing `/missing.js` still returns a real error rather than HTML.
- Every security header the threat model calls for, checked on a live response.
- The function itself. `aws lambda invoke` returns `{"status":"ok"}`, and the Function URL
  answers correctly when called with a hand-computed SigV4 signature.
- The free-tier shape: 23 resources, nothing outside a perpetual allowance except S3.

**Blocked:** every request through `https://<distribution>/api/*` returns 403 from the
Function URL's authorization layer, with zero invocations and no log stream.

The cause is account-level, not configuration. Six variants were tried, including a
throwaway distribution and a throwaway function built from scratch, with and without an
origin request policy. All returned 403. Meanwhile a Function URL with `auth-type NONE`
and a `Principal: "*"` policy is *also* refused, while the same URL under `AWS_IAM`
answers a signed request normally — so this account permits Function URL invocation by an
IAM identity and refuses it for both public callers and the CloudFront service principal.
The account also shows `ConcurrentExecutions: 10` where the default is 1,000, which is
what an unverified account looks like.

Hardening added while the blocker stands, all of it free:

- Four CloudWatch alarms on one SNS topic — unexpected invocation volume, API errors,
  Lambda throttling, and table throttling. For a single-user vault, "is anyone else
  calling this?" has a clear answer, and these are how it gets answered quickly.
  **The email subscription is `PendingConfirmation` until the link in the first message
  is clicked; until then no alarm is delivered.**
- A concurrency ceiling was attempted and is not currently possible — see below.

Two faults were found by reading the plan rather than the code, and both are now
recorded rather than silently wrong:

- **The distribution accepts TLS 1.0 and 1.1**, verified with `openssl s_client`.
  `minimum_protocol_version` is only honoured for a custom ACM certificate; on the
  default `*.cloudfront.net` certificate it is discarded, which also produced a diff on
  every plan that could never converge. The setting has been removed and the consequence
  written into [docs/threat-model.md](docs/threat-model.md). Browsers refuse those
  versions themselves, so the Android client must require TLS 1.2+ on its own.
- **Reserved concurrency cannot be set on this account.** AWS refuses any reservation
  that would take unreserved concurrency below 10, and this account's total is 10.

## Two ways forward

1. **Ask AWS to lift the account restrictions.** Account and billing support is free on the
   Basic plan. The evidence to cite is the reduced concurrency limit and the refusal of
   both public and service-principal Function URL invocation. This keeps the architecture
   exactly as designed.
2. **Put an HTTP API in front of the function instead.** Works today and needs no
   permission from anyone. Its free tier is twelve months rather than perpetual; after
   that it is USD 1.00 per million requests, so a single-user vault making on the order of
   ten thousand requests a month costs around a cent a month. That is not zero, and the
   cost target is zero, so it is a decision to take deliberately rather than by default.

Making the Function URL public is not an option — this account refuses that too.

## Next

1. **Apply the AWS stack.** `make apply STACK=aws` in the `infra` repository. The
   CloudFront distribution takes around fifteen minutes to reach a deployed state.
2. **Set the two server secrets out of band**, with `aws ssm put-parameter`. The API
   refuses to start while they hold their placeholder values, which is deliberate: it
   fails closed rather than running with a secret anyone could read out of a plan.
3. **Web client** — the SPA. The Content-Security-Policy it must satisfy is already
   declared on the distribution: no inline script, no eval, and `img-src` with no remote
   hosts, so site favicons cannot be fetched from a third party.
4. **CI deploy** — bundle and update the function, sync the built client to S3,
   invalidate the distribution.
5. **Backups and monitoring** — scheduled encrypted export to S3, CloudWatch alarms.

Later, once the vault is stable: the marketing site, the admin surface, and the Android
client.

## Open questions

- **Does any data from the previous implementation still exist?** Its PostgreSQL volume
  lived on a virtual machine that has been destroyed. If there is no export, this is a
  clean start with nothing to migrate — which removes a migration path from the plan
  rather than adding one.
- **Argon2id instead of PBKDF2.** Deferred rather than rejected outright; see
  [decisions/0001](decisions/0001-cryptography-and-key-hierarchy.md). Revisit if a
  reviewed, dependency-light WebAssembly implementation becomes available.

## Recently done

**2026-09-22 — `services/api` written.** Registration, login, recovery, session rotation,
and the vault routes. Tested against an in-memory store.

**2026-09-22 — AWS stack written.** Table, function, URL, distribution, buckets, role,
and parameters, in the `infra` repository. Not applied.

**2026-09-22 — `packages/crypto` written.** Key hierarchy, sealed-blob format, entry and
folder encryption, TOTP. No runtime dependencies. Vectors from published standards,
cross-checked against two independent implementations.

**2026-09-22 — Repository created; cryptography, storage, and threat model decided.**
Started from an empty directory rather than porting the previous implementation, which
claimed zero-knowledge but transmitted the master password to the server.

**2026-09-22 — AWS account verified empty.** Seventeen regions swept. The virtual machine
that had been running terminated on 21 September; daily spend has been zero since.
