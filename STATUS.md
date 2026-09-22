# Status

What is in flight. Updated when something starts, stalls, or finishes.

Last updated: 2026-09-22

## Right now

**Phase 3 — the API is written and tested.** `services/api`, one Lambda handler, 47 tests
against an in-memory store, 98% line and 99% function coverage. No AWS account is needed
to run them.

What it enforces, each covered by a test:

- The master password never arrives; only an Auth Key, and only its scrypt verifier is
  stored. A test asserts the address and the auth key appear nowhere in the table.
- An unknown address and a wrong password return the same status and the same body, and
  the verifier runs against a dummy so the timing matches. `prelogin` answers unknown
  addresses with a decoy salt that is stable per address.
- Changing the master password rewrites one item. A test registers three entries, changes
  the password, and asserts not one entry was touched — the claim
  [0001](decisions/0001-cryptography-and-key-hierarchy.md) is built around.
- A replayed refresh token revokes every session, because a token presented twice is the
  signature of a stolen one.
- Registration is closed unless explicitly opened, so a missing setting refuses rather
  than leaving the vault open.

Phase 2 is written but **not applied** — no AWS resource exists yet. Phase 1 and Phase 0
are complete.

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
