# infra

Terraform for everything the vault runs on. One instance, one NoSQL table, one Object
Storage bucket, and a network of their own.

Nothing here is shared with any other project in the tenancy — not the network, not the
state file, not the bucket. That is the point: a change made for something else cannot
reach the host running the vault, and a mistake here cannot reach theirs.

Reasoning: [../decisions/0003](../decisions/0003-running-everything-on-oci.md).
Procedures: [../docs/runbook.md](../docs/runbook.md).

## First run

```sh
./bootstrap/create-state-bucket.sh          # once, ever
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform plan
terraform apply
```

The bootstrap script exists because Terraform cannot create the bucket it stores its own
state in.

## What is where

| File | Owns |
|---|---|
| `network.tf` | VCN, subnet, gateway, and the security group |
| `compute.tf` | The instance, and the cloud-init that sets it up |
| `nosql.tf` | The vault table |
| `storage.tf` | The bucket exports are written to |
| `iam.tf` | The dynamic group and policy the instance authenticates through |
| `monitoring.tf` | The alerts topic, its subscriptions, and the health alarms |
| `cloud-init.yaml` | Caddy, Node, the systemd unit, the firewall |

## Things that are the way they are on purpose

**SSH has no ingress rule by default.** `ssh_allowed_cidr` is an empty list. Set it to a
single address when you need to get in, and empty it again afterwards — the runbook has
the commands. An earlier network in this tenancy left SSH open to `0.0.0.0/0`; that is not
repeated on the host serving a password manager.

**The dynamic group matches one instance OCID, not a compartment.** The compartment is
shared with other projects. A compartment-wide rule would hand their instances the vault's
permissions.

**The NoSQL table carries `prevent_destroy`.** It is the vault. Removing it takes three
deliberate steps, which is the intent.

**Capacity is provisioned at the free rate, not above it.** A flood throttles rather than
bills. Throttling is the intended behaviour here.

**The image OCID is ignored after creation.** Otherwise bumping a variable would destroy
and recreate the instance, taking the disk with it.
