# Status

What is in flight. Updated when something starts, stalls, or finishes.

Last updated: 2026-09-22

## Right now

**Phase 0 — foundation.** No application code and no deployed infrastructure. The AWS
account was verified empty on 2026-09-22: seventeen regions swept, no compute, storage,
network, or data resources, and a daily spend of zero.

**Phase 0 is complete.**

- Repository created, cryptographic design and storage model decided and recorded, threat
  model written.
- A billing guardrail exists on the AWS account: a $1 monthly cost budget named
  `personal-account-monthly`, alerting to developer.shivamsharma@gmail.com at 50% of
  actual spend, at 100% of actual spend, and on a forecast that would exceed the limit.
  There was previously no budget and no billing alarm, which is how an earlier
  ₹1,470 charge went unnoticed until after it had been incurred. The limit is set at $1
  rather than a realistic ceiling because the intended steady state is zero; any alert at
  all means something unexpected is running.

## Next

1. **`packages/crypto`** — key derivation, wrapping, entry encryption, TOTP. No third-party
   dependencies, test vectors from published standards, full coverage, gated in CI. Built
   before anything else because every other component depends on it and because a defect
   here cannot be repaired after data is written.
2. **Terraform** — DynamoDB at provisioned 25/25 with autoscaling off, Lambda and its
   Function URL, S3 and CloudFront with an Origin Access Control, SSM parameters,
   least-privilege IAM.
3. **API** — the Lambda handler, scrypt verifier, short-lived access tokens with refresh
   rotation.
4. **Web client** — the SPA, served under a strict Content-Security-Policy.
5. **CI/CD and hardening** — typecheck, lint, tests, crypto vectors, dependency alerts,
   static analysis, path filters.
6. **Backups and monitoring** — scheduled encrypted export to S3, CloudWatch alarms.

Later, once the vault is stable: the marketing site, the admin surface, and the Android
client. The Android client is the structural answer to the browser-delivered-code threat
in [docs/threat-model.md](docs/threat-model.md); the shared test vectors exist from the
start so that it can be written against them.

## Open questions

- **Does any data from the previous implementation still exist?** Its PostgreSQL volume
  lived on a virtual machine that has been destroyed. If there is no export, this is a
  clean start with nothing to migrate — which removes a migration path from the plan
  rather than adding one.
- **Argon2id instead of PBKDF2.** Deferred rather than rejected outright; see
  [decisions/0001](decisions/0001-cryptography-and-key-hierarchy.md). Revisit if a
  reviewed, dependency-light WebAssembly implementation becomes available.

## Recently done

**2026-09-22 — Repository created; cryptography, storage, and threat model decided.**
Started from an empty directory rather than porting the previous implementation, which
claimed zero-knowledge but transmitted the master password to the server.

**2026-09-22 — AWS account verified empty.** Seventeen regions swept. The virtual machine
that had been running terminated on 21 September; daily spend has been zero since.
