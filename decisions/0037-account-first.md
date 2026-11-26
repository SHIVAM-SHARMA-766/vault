# 0037: An account first, a vault later, and the email address as the username

Status: Accepted by the operator on 2026-11-26; built
Date: 2026-11-26
Builds on: [0036](0036-account-then-master-password.md)

## Context

0036 made sign-in two steps, but an account was still created together with its vault. The
operator asked for a separate first step:
1. Anyone can create an **account**. They type their email and an account password, and an
   **emailed code** proves the address is theirs.
2. Having an account is not having a vault:
   - with open registration, the account creates its vault;
   - with invitation-only registration, the person **asks for a vault**, and an administrator
     approves it from the console.
3. Administrators can edit the emails this sends: the code, the invitation and the approval.

The operator also decided that **the email address is the username**: shown to the person and to
staff.

## Decision

**Sign-up** (needs mail on the server):
- `POST /api/auth/account/signup` sends a 6-digit code, valid for 10 minutes, five tries.
- The answer is the same for every address. An address that already has an account gets an email
  saying so instead of a code, so the form reveals nothing.
- `…/signup/verify` takes the code and the account password (as its proof, 0036). It creates
  **an account with no vault**: two rows, the account under its user id and a pointer from its
  address. It is not in the server's user registry, and it signs in at once.

**An account with no vault** signs in with its account password. The app then shows:
- **Create your vault** when registration is open or an administrator approved. The master
  password and recovery key are created as at registration, through `POST /api/auth/register`
  with the account token, keeping the same user id and account password.
- otherwise **Ask for a vault**, with an optional note, or **I have an invitation code**.

Every registration rule still holds: setup codes, invitations, company invitations (0033), the
personal edition's one account (0030), and SSO provisioning (0021). An approval counts as an
invitation.

**Requests** appear in the console (Invitations → *Requests for a vault*) with the address and the
note:
- **Approve** sets the account's approval and emails the person, who then creates the vault.
- **Decline** clears the request.

Both are audited.

**The address is the username:**
- It is stored on the account and the registry, sealed with AES-256-GCM under a key from the
  pepper. Accounts from before keep theirs from their next account sign-in.
- The console's user list shows it, with the label as a note beside it.
- Lookups still go through the keyed digest. Before this decision, only the digest was stored.

**Email templates** (console → System → Email templates) now cover the sign-up code, the
approval and the account-password reset link, besides the invitation and the sign-in notice. As
before, an administrator changes the subject and adds a message; codes, links and security text
are always included.

**Mail never goes to reserved names** (`example.com/.net/.org`, `.example`, `.test`, `.invalid`,
`.localhost`). Those can never receive mail, so demo and test accounts cause no bounces.

**Rate limits:**
- sign-up codes and reset links have their own buckets: 20 per 15 minutes per network address,
  5 per inbox;
- the account prelogin has its own bucket (60);
- the sign-in limit counts only password checks.

Without mail, the old one-step sign-up with an invitation remains.

## Consequences

- The server now knows each account's email address. Staff can see it, and a database dump plus
  the pepper reveals it. The site's security page and FAQ say so. Vault contents are unchanged:
  readable only with the master password.
- Sign-up depends on mail: the reference instance sends through Gmail (scripts/set-mail.sh).

## Tests

- **API** (4):
  - no sign-up without mail;
  - the code: wrong, right, and once only;
  - an account with no vault signs in, and has nothing to unlock;
  - invitation only: refused, request, the console lists the address and note, approval emails
    the person, the vault is created with the same user id, and the address shows in the user
    list;
  - open registration creates at once;
  - a token is for one address only;
  - an existing address is told by email;
  - declining approves nothing.
- **e2e:**
  - sign up with a wrong code, then the right one;
  - ask for a vault;
  - the owner approves in the console, and the email goes out (dev outbox);
  - the person creates the vault;
  - a lock asks only the master password;
  - the console names the person by address;
  - the existing suites still pass, with the register helper handling the new sign-up when mail
    is on.
