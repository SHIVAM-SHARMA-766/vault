# Runbook

Operational procedures. Written for whoever is doing this at 2am, which is the same
person who built it and will not remember.

Infrastructure lives in the `infra` repository under `stacks/aws`; see
[decisions/0003](../decisions/0003-where-infrastructure-is-defined.md). Every command
below assumes `AWS_PROFILE=aws-shivamsharma` unless it says otherwise.

## First deploy

```sh
cd ~/shivam/infra
make plan STACK=aws        # read it; 0 to destroy is the only acceptable plan
make apply STACK=aws       # CloudFront takes ~15 minutes to reach Deployed
make output STACK=aws
```

The distribution reports `InProgress` for some minutes after Terraform returns. That is
CloudFront propagating, not a failure.

## Setting the server secrets

**The API refuses to start until this is done.** Terraform creates both parameters with a
placeholder it then ignores, because a value passed through Terraform is written to the
state file in plaintext — a different security boundary from Parameter Store, and one
that gets copied to laptops and CI runners. The handler checks for the placeholder and
throws rather than running with a secret anyone could read out of a plan.

```sh
export AWS_PROFILE=aws-shivamsharma
aws ssm put-parameter --name /vault/server-pepper --type SecureString \
  --overwrite --value "$(openssl rand -base64 32)"
aws ssm put-parameter --name /vault/token-signing-key --type SecureString \
  --overwrite --value "$(openssl rand -base64 48)"
```

### What each one does, and what rotating it costs

**`server-pepper`** keys the HMAC that turns an email address into a database key, and the
decoy salt returned for unknown addresses. **Rotating it orphans every existing account** —
the digest changes, so the login pointer can no longer be found. Treat it as permanent.
If it must be rotated, every account has to be re-registered.

**`token-signing-key`** signs access and refresh tokens. Rotating it logs everyone out and
costs nothing else. Safe to do at any time, and the right response to any suspicion that
it leaked.

## Opening registration for the first account

Registration is closed unless `ALLOW_REGISTRATION` is exactly `"true"`, so a missing or
misspelled value refuses rather than leaving the vault open to whoever finds the URL.

```sh
cd ~/shivam/infra
# stacks/aws/terraform.tfvars
echo 'allow_registration = true' >> stacks/aws/terraform.tfvars
make apply STACK=aws
```

Register, **write the recovery key down before closing the browser tab** — it is shown
once and never transmitted again — then close registration:

```sh
sed -i 's/allow_registration = true/allow_registration = false/' stacks/aws/terraform.tfvars
make apply STACK=aws
```

## Deploying code

CI owns the function's code; Terraform only provisions it and ignores changes to it
thereafter. An `apply` run for an unrelated reason therefore cannot roll the API back to
its placeholder.

```sh
cd ~/shivam/vault
npm test                                      # both workspaces
npm run bundle --workspace @vault/api
# then: update-function-code, s3 sync, create-invalidation
```

## When the budget alert fires

The budget is USD 1 a month with alerts at 50%, at 100%, and on a forecast overrun. The
intended steady state is zero, so **any alert means something unexpected is running.**

```sh
export AWS_PROFILE=aws-shivamsharma
aws ce get-cost-and-usage --time-period Start=$(date -u +%Y-%m-01),End=$(date -u +%Y-%m-%d) \
  --granularity MONTHLY --metrics UnblendedCost \
  --group-by Type=DIMENSION,Key=SERVICE --output table
```

The usual culprits, in order of likelihood:

| Symptom | Cause |
|---|---|
| `EC2 - Other` or `Virtual Private Cloud` | A public IPv4 address, or a NAT gateway. Nothing in this stack creates either |
| `DynamoDB` above zero | Capacity mode changed to on-demand, or an autoscaling target was added. Both must never exist — see `stacks/aws/dynamodb.tf` |
| `Secrets Manager` | Something migrated off Parameter Store. It bills per secret per month |
| `API Gateway` | Something replaced the Function URL. Its free tier expires after twelve months; Lambda's does not |

### Verifying the account is actually empty

**Do not run a sweep with the query inline in `$( )`.** Backticks are still interpreted by
the shell there, so a JMESPath filter such as ``State.Name!=`terminated` `` is silently
mangled into invalid syntax; the CLI errors, and empty output reads as "nothing found".
This produced a false all-clear on 2026-09-22. Put the queries in a script file, and do
not discard stderr.

Also note that Cost Explorer lags for the current day: a reading of zero for today means
"not reported yet", not "nothing is running".

## Recovering the vault

Backups are a scheduled export of the DynamoDB table to S3. The exported items are
ciphertext the server holds no key for, so a leaked export is no worse than a leaked
table and needs no protection the table does not already have.

```sh
aws s3 ls s3://vault-backups-505521407909/
```

Restoring means writing the items back into the table. The vault key is unaffected by any
of this — it lives only in wrapped form, and only the master password or the recovery key
can unwrap it.

**If both the master password and the recovery key are gone, the vault is gone.** The
server cannot help; that is the design working, not a failure. See
[decisions/0001](../decisions/0001-cryptography-and-key-hierarchy.md).

## Tearing the stack down

The table carries both AWS deletion protection and Terraform's `prevent_destroy`, so
`terraform destroy` refuses twice. That is deliberate: it is the vault.

To genuinely remove it, take an export first, then remove `prevent_destroy` from
`dynamodb.tf` and set `deletion_protection_enabled = false`, apply, and only then destroy.
Three deliberate steps, which is the point.
