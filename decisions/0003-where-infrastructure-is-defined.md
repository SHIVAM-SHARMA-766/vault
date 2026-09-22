# 0003 — Where infrastructure is defined

Status: Accepted
Date: 2026-09-22

## Context

The vault needs a DynamoDB table, a Lambda function, two S3 buckets, a CloudFront
distribution, and an IAM role. Something has to own those definitions, and there are two
repositories that could: this one, or the separate `infra` repository that holds
Terraform for every provider.

An earlier version of [ARCHITECTURE.md](../ARCHITECTURE.md) assumed this repository would
own them, listing an `infra/` directory in the planned layout. That assumption was made
without checking, and it was wrong on two counts.

First, the estate-level decision already exists and says otherwise: `infra` holds one
Terraform state per provider, and its `stacks/aws` directory was **already scaffolded for
this exact workload** — its header reads "AWS stack — the vault API and its data store",
with a TODO recording that it was blocked on the data model being designed. That data
model is now [0002](0002-storage-and-data-model.md).

Second, `infra` already has a working state backend — an Object Storage bucket reached
through its S3-compatible API — and its `stacks/oci/terraform.tfstate` confirms the
arrangement has been used. Standing up a second state store for this repository would
duplicate something that works.

## Decision

**Infrastructure lives in the `infra` repository, in `stacks/aws`. This repository holds
application code, design records, and nothing Terraform reads.**

The split is by lifecycle rather than by subject matter:

| Concern | Repository | Why |
|---|---|---|
| Provisioning — table, function, buckets, distribution, role | `infra` | Changes on its own schedule, once every few months |
| Application code, including the function's own source | this one | Changes on every commit |
| Account baseline — budgets, state backend | `infra` | Not specific to the vault |

**Terraform provisions the function but does not own what runs in it.** The Lambda
resource is created with a placeholder handler that returns 501, and `lifecycle {
ignore_changes = [filename, source_code_hash] }`. Continuous integration in this
repository replaces the code on every deploy. Without that, an `apply` run for an
unrelated reason would roll the API back to the placeholder.

The two repositories therefore meet at exactly three values, published as Terraform
outputs and read by CI: the function name, the client bucket, and the distribution id.

## Rejected

**Terraform in this repository.** Co-locating an application with its infrastructure
allows a single pull request to change a handler and the table it reads, which is a real
advantage. Rejected because the estate decision and the working state backend both
already exist, and because re-deciding a recorded decision on a preference this narrow is
how a solo operator ends up with two conventions and no reason to prefer either.

**Terraform owning the function's code.** Deploys would then be `terraform apply`, which
is one fewer mechanism. Rejected because it couples every code deploy to a tool that also
holds the table's definition — an unrelated `apply`, run to change a log retention, would
carry whatever code the working tree happened to contain.

**A second Terraform state for this repository's resources.** Two states that both touch
one AWS account eventually disagree about something they both reference.

## Consequences

**A deploy spans two repositories.** CI here needs the outputs of a stack defined
elsewhere. They are read from Terraform outputs rather than copied into configuration, so
that renaming a resource does not silently break deploys.

**Infrastructure review happens in the other repository.** A change to the table's
capacity or the distribution's headers is not visible in this repository's history, and
[ARCHITECTURE.md](../ARCHITECTURE.md) points at `infra` rather than describing resources
it does not contain.

**The free-tier constraints are enforced where the resources are declared.** The rules
that keep the bill at zero — provisioned capacity fixed at 25/25, no autoscaling, no API
Gateway, no NAT gateway, no Secrets Manager — are comments and assertions in `infra`, not
here. They are repeated in [ARCHITECTURE.md](../ARCHITECTURE.md) only as a summary.
