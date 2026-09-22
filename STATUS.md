# Status

What is in flight. Updated when something starts, stalls, or finishes.

Last updated: 2026-09-22

## Right now

**Phase 1 — the cryptography package.** `packages/crypto` is written, tested, and
building. It has no runtime dependencies and implements no algorithm by hand: every
primitive comes from Web Crypto, which resolves to the browser's implementation in a page
and to Node's in the API and in tests.

- 83 tests, 100% line and function coverage, 98% branch coverage.
- 30 test vectors from RFC 7914, RFC 5869, RFC 4231, RFC 6238, and the GCM
  specification. They were cross-checked against Python's `hashlib`/`hmac` and OpenSSL
  before being committed, and are deliberately not generated from this implementation —
  a vector produced by the code it tests passes whether or not that code is correct.
- CI runs typecheck, tests, and `npm audit`, and fails the build if the crypto package
  ever acquires a runtime dependency or if a vector file stops citing where it came from.

Phase 0 is complete: the repository, the three design documents, and a $1 monthly budget
on the AWS account alerting at 50% and 100% of actual spend and on a forecast overrun.
The account itself was verified empty on 2026-09-22 — seventeen regions swept, nothing
running, daily spend zero.

## Next

1. **Terraform** — DynamoDB at provisioned 25/25 with autoscaling off, Lambda and its
   Function URL, S3 and CloudFront with an Origin Access Control, SSM parameters,
   least-privilege IAM.
2. **API** — the Lambda handler, scrypt verifier over the client-supplied Auth Key,
   short-lived access tokens with refresh rotation, and the decoy-salt response that
   keeps the login endpoint from confirming whether an address is registered.
3. **Web client** — the SPA, served under a strict Content-Security-Policy.
4. **Hardening** — static analysis, and the security headers the threat model requires
   on the CloudFront distribution.
5. **Backups and monitoring** — scheduled encrypted export to S3, CloudWatch alarms.

Later, once the vault is stable: the marketing site, the admin surface, and the Android
client. The Android client is the structural answer to the browser-delivered-code threat
in [docs/threat-model.md](docs/threat-model.md); it will assert against the same vector
files `packages/crypto` does, which is why those exist before it is written.

## Open questions

- **Does any data from the previous implementation still exist?** Its PostgreSQL volume
  lived on a virtual machine that has been destroyed. If there is no export, this is a
  clean start with nothing to migrate — which removes a migration path from the plan
  rather than adding one.
- **Argon2id instead of PBKDF2.** Deferred rather than rejected outright; see
  [decisions/0001](decisions/0001-cryptography-and-key-hierarchy.md). Revisit if a
  reviewed, dependency-light WebAssembly implementation becomes available.

## Recently done

**2026-09-22 — `packages/crypto` written.** Key hierarchy, sealed-blob format, entry and
folder encryption, TOTP. No runtime dependencies. Vectors from published standards,
cross-checked against two independent implementations.

**2026-09-22 — Repository created; cryptography, storage, and threat model decided.**
Started from an empty directory rather than porting the previous implementation, which
claimed zero-knowledge but transmitted the master password to the server.

**2026-09-22 — AWS account verified empty.** Seventeen regions swept. The virtual machine
that had been running terminated on 21 September; daily spend has been zero since.
