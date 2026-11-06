# 0011 — Two-factor sign-in

Status: Accepted
Date: 2026-11-06

## Context

A master password can be phished, reused, or watched over a shoulder. Every password manager
a business would compare Vault with offers a second factor at sign-in, and organization
policies (phase 3) will want to require one.

Vault's zero-knowledge design changes what a second factor can and cannot do here. It cannot
protect the vault's contents from the server — nothing the server checks can, because the
server never has the keys. What it does is stop someone who has the master password but not
the second factor from obtaining the wrapped vault key and a session, which is exactly the
attack it is for.

## Decision

**TOTP (RFC 6238) with single-use recovery codes, checked by the server after the password is
proved, at sign-in and at recovery-key sign-in.**

- **Order of checks.** The auth key is verified first. Only then does the server say a second
  factor is needed (`401 two_factor_required`), so the response tells a stranger nothing about
  whether an account exists or has 2FA. Without a valid code the response carries no wrapped
  vault key and no session.
- **The TOTP key** is the one user secret the server must be able to read, because it checks
  codes. It protects sign-in, not the vault. It is sealed with AES-256-GCM under a key derived
  from the server pepper, which lives outside the database, so a database dump does not yield
  it. It is generated on the server (160 bits) and shown once, as a QR code and as text.
- **Replay.** The step of the last accepted code is stored; a code for that step or earlier is
  refused, so a code seen over a shoulder cannot be used again in its window. One step either
  side of now is accepted for clock drift.
- **Recovery codes.** Ten codes of 50 bits, Crockford base32, shown once, stored as HMACs under
  the pepper. Each works once. New codes replace all old ones and need the password and a
  current code.
- **Turning it on** needs the master password, then a valid code from the new key within ten
  minutes. **Turning it off** needs the master password and a current code or recovery code.
- **Recovery-key sign-in also needs the second factor.** The recovery key stands in for the
  password, not for the phone. Someone who has lost both their phone and their password uses
  a recovery code.
- **Admin reset.** An admin (or owner) can turn off a member's 2FA — for the person who lost
  both phone and recovery codes. It is subject to the usual rank rules and recorded in the
  audit log. It does not let the admin into the vault: the member still needs their master
  password.
- **Brute force.** Every code attempt is a sign-in attempt, already limited to ten per fifteen
  minutes per address and per IP. A six-digit code with a three-step window cannot be guessed
  inside that budget.
- **The QR code is drawn by our own encoder** (`packages/core/src/qr.ts`), checked module for
  module against an independent implementation, rather than a third-party library on the page
  that holds the vault key.

WebAuthn (security keys, passkeys as a second factor) is the next factor; it is phishing-
resistant where TOTP is not.

## Consequences

- `GET /api/auth/me` reports `twoFactor: { enabled, recoveryCodesLeft }`; the admin user list
  shows who has 2FA on.
- Rotating `SERVER_PEPPER` would make every sealed TOTP key and recovery-code hash unreadable,
  in addition to orphaning every account (as it already did). The runbook's warning stands.
- Organization policy "require 2FA" (phase 3) is now possible.
