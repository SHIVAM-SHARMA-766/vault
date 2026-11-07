# 0014 — A built-in service desk

Status: Accepted
Date: 2026-11-07

## Context

The operator asked for Vault to have its own ITSM: a way for people to ask for an invitation,
get help when their one-time codes stop working, and get support — without email threads or
chat tools outside the product. Three facts shape it:

- Two of the three requests come from people who **cannot sign in**: someone without an
  account, and someone locked out of their authenticator.
- Vault stores **no email addresses**, only keyed digests (threat A7), yet answering someone
  needs an address.
- A two-factor reset requested by a stranger is the classic **social-engineering** path into
  an account.

## Decision

- **Tickets of three kinds** in the database's `DESK` partition: `access` and `signin` (public,
  from the sign-in screen) and `support` (signed-in users). Status open → in progress →
  waiting → resolved → closed; priority; assignment; a conversation with staff-only notes.
- **Public requests** are rate-limited per address and per email, answer identically whether
  or not an account exists, and carry the requester's email address **only while open** — it
  is erased when the ticket closes, and resolved tickets close after seven days. Signed-in users
  opt in to email updates the same way.
- **Two one-click actions**: approving an access request issues an invitation (and emails it);
  a sign-in request can have two-factor sign-in reset — but only by someone with `users.write`,
  only for a non-owner account, always audited, and the UI insists the person is verified
  through another channel first.
- **A `support` role** works the queue and issues invitations, and can change no account.
- **Ticket text is not end-to-end encrypted.** It is support conversation, not vault data;
  staff must read it. The UI says, at every place text is entered, never to put a password,
  recovery key or code in it.

## Consequences

- A new public endpoint (`POST /api/desk/requests`) — bounded by its rate limits and by
  creating nothing but a ticket.
- Threat model A13 records the social-engineering risk and its mitigations.
- Staff are not notified of new tickets by email (Vault has no staff addresses); the admin
  Overview counts open tickets. Organizations (phase 3B) may add per-team queues.
