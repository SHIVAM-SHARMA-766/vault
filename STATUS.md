# Status

What is in flight. Updated when something starts, stalls, or finishes.

Last updated: 2026-09-22

## Right now

**Phase 2 — infrastructure, written but not applied.** The AWS stack is implemented in
the `infra` repository under `stacks/aws` (see
[decisions/0003](decisions/0003-where-infrastructure-is-defined.md)). It validates, and
plans clean at 23 resources to add and nothing to destroy. **It has not been applied**,
so no AWS resource exists yet.

The plan was checked against the constraints that keep the bill at zero, each asserted
rather than assumed: DynamoDB provisioned at 25/25 with no autoscaling target and no
secondary indexes, point-in-time recovery off, Lambda on arm64 and outside any VPC so no
NAT gateway is implied, log retention set explicitly, the Function URL IAM-signed, and no
API Gateway, Secrets Manager, or NAT gateway anywhere in the plan.

Phase 1 is complete: `packages/crypto`, 83 tests, 100% line and function coverage, 30
vectors from published standards, CI green.

Phase 0 is complete: the repository, the design documents, and a $1 monthly budget with
alerts at 50% and 100% of actual spend and on a forecast overrun.

## Next

1. **Apply the AWS stack.** `make apply STACK=aws` in the `infra` repository. The
   CloudFront distribution takes around fifteen minutes to reach a deployed state.
2. **Set the two server secrets out of band.** Terraform creates the SSM parameters with
   a placeholder and ignores their values thereafter, because a value passed through
   Terraform is written to the state file in plaintext — a different security boundary
   from the parameter store.
3. **API** — the Lambda handler, scrypt verifier over the client-supplied Auth Key,
   short-lived access tokens with refresh rotation, and the decoy-salt response that
   keeps the login endpoint from confirming whether an address is registered.
4. **Web client** — the SPA. The Content-Security-Policy it must satisfy is already
   declared on the CloudFront distribution: no inline script, no eval, and `img-src` with
   no remote hosts, so site favicons cannot be fetched from a third party.
5. **CI deploy** — sync the built client to S3, invalidate the distribution, update the
   function's code. The three Terraform outputs it needs are the bucket, the distribution
   id, and the function name.
6. **Backups and monitoring** — scheduled encrypted export to S3, CloudWatch alarms.

Later, once the vault is stable: the marketing site, the admin surface, and the Android
client. The Android client asserts against the same vector files `packages/crypto` does,
which is why those exist before it is written.

## Open questions

- **Does any data from the previous implementation still exist?** Its PostgreSQL volume
  lived on a virtual machine that has been destroyed. If there is no export, this is a
  clean start with nothing to migrate — which removes a migration path from the plan
  rather than adding one.
- **Argon2id instead of PBKDF2.** Deferred rather than rejected outright; see
  [decisions/0001](decisions/0001-cryptography-and-key-hierarchy.md). Revisit if a
  reviewed, dependency-light WebAssembly implementation becomes available.

## Recently done

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
