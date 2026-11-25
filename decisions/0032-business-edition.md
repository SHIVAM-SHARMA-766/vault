# 0032: The business edition

Status: Accepted by the operator on 2026-11-23; built in stages (2a–2d)
Date: 2026-11-23
Implements: [0030](0030-editions.md) stage 2. Builds on [0031](0031-two-workspaces.md).

## Context

0030 made the business edition "the company's server": one organization, the company, with an
admin console for its people. 0031 split administration into the Admin console. What remained
is everything a company admin reaches for that Zoho Vault and 1Password Business offer and
Vault did not.

| | Zoho Vault | 1Password Business | Vault before | Vault after |
|---|---|---|---|---|
| One company, its people in one list | ✓ | ✓ (People) | ✗ server users and org members were separate lists | **2a** |
| Invite someone who has no account yet, in one step | ✓ | ✓ | ✗ a registration invite and an org invite | **2a** |
| Collections, groups, view/edit/manage | ✓ | ✓ (vaults) | ✓ | ✓ |
| "Login only" (fill, never reveal) | ✓ | ✓ | ✓ hide passwords | folded into **2b** |
| Named permission sets, custom permissions | partly (roles) | ✓ (vault permissions) | ✗ | **2b** |
| Team password health | ✓ reports | ✓ Watchtower | ✗ (personal only) | **2c** |
| Guests: one collection, no personal vault | ✗ | ✓ | ✗ | **2d** |
| Access requests, time-limited check-out | ✓ | ✗ | ✓ | ✓ |
| Policies, audit, recovery key | ✓ | ✓ | ✓ | ✓ |
| SSO, SCIM | ✓ | ✓ | ✗ | phase 6 (0021) |

The operator chose all four stages. People join the company **by an admin's invitation**, not by
registering.

## Decisions

### 2a — One company, and People

- **One company per server.** In the business edition, the server refuses a second team
  organization: 409 "This business Vault has one company". The owner creates it, from My
  organizations or from the console's prompt, with its recovery key as usual (0026). Direct
  shares between two people (D11) are still allowed.
- **People replaces Members**, in every edition that has organizations. It is one list:
  - the company's members, the people waiting for an admin to confirm them, and those invited
    who have not joined;
  - for an admin who also holds the server's `users.read` permission, each person's account
    as the server sees it: last sign-in, two-factor, disabled. With `users.write`, also the
    account actions: disable, reset two-factor, offboard.
  - In the business edition, a second group: **accounts on this server that are not in the
    company**, each with **Add to company**.
- **One invitation.** In the business edition, inviting an address with no account also
  creates a single-use sign-up code (the server's invitation, 7 days, emailed when mail is set
  up, shown once otherwise). The person signs up with it, finds the company's invitation
  waiting, accepts, and is confirmed by fingerprint as before (0009). This is limited to the
  business edition. Elsewhere it would tell an organization's admin whether an address has an
  account on someone else's server.
- **Add to company** invites an existing account by its id instead of its address. It is open
  to admins who hold `users.read`, who already see the account list.
- **The console in the business edition**: the company scope comes first. The server scope keeps
  Overview, Service desk, Audit log and System. Users, Invitations and Organizations are gone
  from the server scope, because People and the company cover them.

### 2b — Permission sets (planned)

Named bundles of collection permissions given to people or groups: *Use only* (fill and copy
the username, never reveal or copy the password), *Viewer*, *Editor*, *Manager*, and custom sets
built from finer rights: see history, export, share by link, manage access. The existing
view/edit/manage and hide-passwords become the four built-in sets. Policy enforced by the
server where it can be (writes, access changes), and by the app where only it can (reveal,
copy), as hide-passwords is today.

### 2c — Team password health (planned)

An admin's console computes weak, reused, old and breached passwords across the collections the
admin manages, in the admin's browser, as the personal health check does. The server never sees
a password or a score. The report lists items, not people.

### 2d — Guests (planned)

An account limited to the collections it is given. It has no personal vault features beyond what
it needs (no emergency access, no organizations of its own), and an optional end date. A guest
counts as a member for keys and audit, and is marked as a guest everywhere admins see people.

## Tests

- API: a second company is refused in business and allowed in hosted; an invitation with sign-up
  returns a code only in business and only for an address without an account; Add to company
  needs `users.read`.
- e2e: the owner creates the company. People invites a newcomer, who signs up with the code,
  accepts and is confirmed. An existing account is added to the company. The account columns
  show for an admin with `users.read`.
