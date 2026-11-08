# 0019 — Breach check: k-anonymity, relayed, on request

Status: Accepted
Date: 2026-11-08
Builds: [0001](0001-cryptography-and-key-hierarchy.md); settles "breach checks" from the phase 3.5 crypto questions

## Context

Password health found weak, reused, old and http-only passwords locally, but not passwords that
are already in public breach lists, which attackers try first. 1Password (Watchtower) and
Bitwarden both check against Have I Been Pwned's Pwned Passwords. Our principle 2 (ROADMAP)
says an unavoidable outside service gets a decision record and a privacy-preserving protocol.

## Decision

**Pwned Passwords' range API, which is k-anonymous, relayed by our own server, run only when the
person asks.**

- The browser hashes each distinct password with SHA-1 and sends **only the first 5 hex
  characters** (20 of 160 bits). The range response lists every known suffix under that prefix,
  hundreds of them, and the server asks for `Add-Padding: true` so the response size reveals
  nothing. The browser compares suffixes itself.
- **Relayed** through `GET /api/breach/range/:prefix`, because the page's
  Content-Security-Policy allows no third-party origin, and we keep it that way. The server
  caches each range for an hour, rate-limits per account, and sends a generic user agent.
  Neither the server nor Pwned Passwords sees a password or a full hash. Pwned Passwords sees
  the server's address, not the person's.
- **On request**, behind a **Check for breaches** button in Password health, with the protocol
  explained in a line beside it. The results stay in memory for the current unlock and are
  forgotten on lock. Which of your passwords are breached is itself sensitive, so it is never
  stored or synced.
- **Operators can turn it off** (`BREACH_CHECK=false`) or point it at a mirror inside their
  network (`BREACH_CHECK_URL`). When it is off, the button is not shown.
- A breached password is a password issue like *weak*, and lowers the score.

## Rejected

- **Calling Pwned Passwords from the browser.** This would mean opening the CSP to a third
  party, and every person's address would reach that third party.
- **Downloading the whole corpus to the server.** That is tens of gigabytes, against the $0 and
  small-machine targets. A mirror is still possible through `BREACH_CHECK_URL`.
- **Checking automatically on every unlock.** Prefixes would go out silently and repeatedly. A
  person can learn the protocol and choose. An automatic option can come later as a preference.
- **Storing results** (sealed in preferences): small gain, a new sensitive record to protect.

## Consequences

- An observer of the relay learns that someone on this server has a password whose SHA-1 begins
  with a given 5-character prefix, shared with roughly 500 to 1,000 other known passwords. This
  is the accepted cost of the protocol.
- A server that lies about ranges can hide a breach or invent one. It cannot learn passwords.
- Offline installs see a "could not be reached" message and lose nothing else.
