# Decisions

One file per decision that was not obvious, recording what was chosen, what was rejected,
and why. Written so that a reader arriving later — including a future AI session — can
tell whether a decision still holds, instead of guessing at the reasoning and repeating
the analysis.

A record belongs here when the reasoning is not recoverable from the code. "We use Oracle
NoSQL" is visible in the Terraform; *why the capacity mode may never change* is not.

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
| [0003](0003-running-everything-on-oci.md) | Running everything on one provider |
| [0004](0004-the-access-token-header.md) | The access token header |
| [0005](0005-pull-based-releases.md) | Releases are pulled by the host |
| [0006](0006-admin-panel.md) | An admin panel that cannot read the vault |
| [0007](0007-roles-and-site-editing.md) | Staff roles, and a website edited from the admin panel |

## A note on the numbering

This set was renumbered once, on 2026-09-22, when the platform changed from AWS to OCI.
Ordinarily a decision that stops being true is superseded by a new one that references it,
and the original stays — the reasoning that led to a wrong answer is worth keeping.

That was not the right thing to do here. The AWS version of this project was built and
applied but never served a request, and half the records described a system that had
stopped existing. Keeping four superseded records about a dead architecture would have
buried the four that describe the live one. [0003](0003-running-everything-on-oci.md)
carries the full account of what was tried on AWS and why it was abandoned, which is the
part worth keeping.

Numbers are stable from here.
