# Decisions

One file per decision that was not obvious, recording what was chosen, what was rejected,
and why. Written so that a reader arriving later — including a future AI session — can
tell whether a decision still holds, instead of guessing at the reasoning and repeating
the analysis.

Numbered sequentially, never renumbered. A decision that stops being true is superseded
by a new one that references it; the original stays in place, because the reasoning that
led to a wrong answer is worth keeping.

A record belongs here when the reasoning is not recoverable from the code. "We use
DynamoDB" is visible in the Terraform; *why the capacity mode may never change* is not.

## Format

Title, status, date, then: Context, Decision, Rejected, Consequences.

**Rejected** carries most of the value. It is what stops an option from being
reconsidered from scratch every few months, and what explains an unusual choice to
someone who would otherwise assume it was an oversight.

## Index

| # | Decision |
|---|---|
| [0001](0001-cryptography-and-key-hierarchy.md) | Cryptography and key hierarchy |
| [0002](0002-storage-and-data-model.md) | Storage and data model |
| [0003](0003-where-infrastructure-is-defined.md) | Where infrastructure is defined |
| [0004](0004-the-access-token-header.md) | The access token header |
| [0005](0005-oci-fallback-for-the-api.md) | Running the API on OCI compute — **proposed**, not adopted |

Infrastructure decisions that span more than this project — provider placement, account
layout — live in the `brain` repository instead.
