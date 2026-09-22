# 0005 — Running the API on OCI compute

Status: **Proposed** — not adopted. This is the fallback if AWS declines to lift the
account restrictions described in [docs/aws-support-request.md](../docs/aws-support-request.md).
Nothing here is built.

## Context

CloudFront cannot invoke the Lambda Function URL. The cause is an account-level
restriction, not configuration: six variants failed, a Function URL with `auth-type NONE`
and a wildcard principal is refused as well, and the account reports a Lambda concurrency
limit of 10 against a default of 1,000. A free support case has been drafted.

Two always-free OCI compute instances already exist in the same city as the AWS region:
`n8n-runner`, which runs the automation runner, and `n8n-ops`, whose only job is to retry
an Ampere A1 launch that has never succeeded — 455 recorded attempts over roughly seven
and a half hours, with the always-free Ampere allocation halved from four OCPUs to two
during 2026.

`n8n-ops` is therefore idle capacity: one OCPU and 1 GB of memory doing nothing useful.
The retry loop it runs is a shell script that can move to `n8n-runner` at no cost.

## Decision, if adopted

Move the API to `n8n-ops`, keep the client where it is, and put CloudFront in front of
both so the browser still sees one origin.

```
Browser ──► CloudFront (*.cloudfront.net, HTTPS)
              ├── /*      → S3                    unchanged, already live
              └── /api/*  → OCI instance          new custom origin
                              │
                              └──► Oracle NoSQL   instance principal, no stored credential
```

### Why CloudFront stays in front

Putting the instance directly on the internet would cost three properties that are
currently held:

- **TLS without a user-facing domain.** CloudFront terminates on its own certificate, so
  the address the browser trusts remains `*.cloudfront.net`.
- **Same origin.** The Content-Security-Policy keeps `connect-src 'self'`, which is what
  stops injected script from exfiltrating to an attacker's host (A3 in the threat model).
  A separate API origin would have to be named in the policy and would need CORS.
- **The instance's address stays unpublished**, and its network security group can be
  narrowed to CloudFront's published ranges.

### Data

**Oracle NoSQL Database Cloud Service.** Its always-free allowance is 133 million reads
and 133 million writes a month across three tables of 25 GB each — more generous than
DynamoDB's 25 provisioned units and 25 GB in total. The single-table design in
[0002](0002-storage-and-data-model.md) maps onto it without change: a shard key and a
sort key, queried by prefix.

It is a managed service, so the data outlives the instance. That matters more here than
it did on AWS, because an always-free OCI instance can be reclaimed (see Consequences).

**Authentication by instance principal.** The `instances` dynamic group already exists in
the OCI stack, so the instance authenticates as itself and no credential is stored on
disk. Keeping the data in DynamoDB instead would mean putting a long-lived AWS access key
on a public-facing host, which is strictly worse.

### Code changes

Small, and both additive:

- `services/api/src/store-nosql.ts` — the `Store` interface is five methods, so this sits
  beside `store-dynamo.ts` rather than replacing anything. The in-memory implementation
  the tests use is unaffected, so the existing 47 tests keep passing unchanged.
- `services/api/src/server.ts` — roughly thirty lines wrapping the existing handler in a
  Node HTTP server. The handler already takes an event and returns a response; nothing
  inside it changes.

### The origin needs a hostname

CloudFront custom origins are specified by domain name; an IP address is not accepted.
The instance has a public IP and no name, so one has to come from somewhere. Without
buying a domain, that means a free dynamic-DNS name with a Let's Encrypt certificate
issued to it on the instance.

**This is the weakest part of the design and it should be stated plainly.** Whoever
controls that DNS name can point it at their own server and obtain a valid certificate
for it, becoming a man in the middle between CloudFront and the API. What they would get
is bounded by the key hierarchy — auth keys and ciphertext, never the master password or
plaintext — so they could destroy or corrupt the vault but not read it. That is the same
bound as A4, a compromised API, which the threat model already accepts. It is a new
dependency in the trust path all the same.

## Rejected

**Running the API on `n8n-runner` alongside the automation runner.** That host holds
credentials for everything it automates, and [the placement decision](../../brain/decisions/0002-workload-placement.md)
records that not exposing it is the largest single security win available. Putting a
public API on it would trade that away.

**Putting the instance directly on the internet, without CloudFront.** Costs the
same-origin property, requires CORS, names a second host in the CSP, and publishes the
instance's address.

**Keeping the data in DynamoDB.** Requires a long-lived AWS access key on a
public-facing host.

**Buying a domain.** Would remove the dynamic-DNS weakness for roughly ₹800 a year. It is
the one place where a small, recurring cost buys a real security improvement, and it is
worth revisiting if this fallback is adopted for good.

## Consequences

**An always-free instance can be reclaimed for being idle.** Oracle's documentation says
idle always-free compute "may be reclaimed" when CPU, network *and* memory utilisation
stay below 20% for seven days. A single-user vault is idle nearly all the time, so this
is a live risk and it is the same class of failure that destroyed the previous
deployment.

Two things reduce it. The wording is conjunctive, and a Node process plus a reverse proxy
on a 1 GB instance plausibly holds memory above 20% on its own — so the first step is to
measure rather than assume. If that is not enough, a keep-warm loop holding CPU above the
threshold will do it, at the cost of burning a core to satisfy a policy. Whether the
tenancy has been upgraded to Pay As You Go also matters, because the reclamation applies
to always-free-only accounts; that is a console check.

**A host to patch, and a single point of failure.** Both were explicitly designed out.
The API stops when the instance stops, and nothing restarts it but the operator.

**The estate gains a fourth moving part** — dynamic DNS — in the path of the most
sensitive thing being run.

**What does not change:** the cryptography, the data model, the threat model's key
hierarchy claims, the client, and the test suite. This is a change of host and of storage
adapter, not of design.

## If this is adopted

1. Move the Ampere retry loop from `n8n-ops` to `n8n-runner` and rename the instance.
2. Check in the OCI console whether the tenancy is always-free or Pay As You Go.
3. Provision the NoSQL table and the instance-principal policy in the `infra` repository.
4. Write `store-nosql.ts` and `server.ts`; the existing tests should pass untouched.
5. Register the dynamic-DNS name, install a reverse proxy, obtain a certificate.
6. Add the origin and the `/api/*` behaviour to the distribution; narrow the network
   security group to CloudFront's ranges and require a shared secret header.
7. Measure idle utilisation for a few days before deciding whether a keep-warm loop is
   needed.
8. Revisit whether to buy a domain.
