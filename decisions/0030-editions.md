# 0030: Three editions from one codebase

Status: Accepted by the operator on 2026-11-21; built in stages
Date: 2026-11-21
Amends: [0010](0010-self-hosted-product.md) ("one product, every size, no separate editions")

## Context

0010 made Vault one product for every size: the same features whether one person or a company
runs it, with organizations, invitations, the service desk and the website editor present
everywhere. In practice that serves no one well. A person installing Vault for themselves meets
invitations, organizations and staff roles they will never use. A company wants the server to
*be* the company, not a place where anyone can create organizations. And the operator wants to
run Vault as a hosted service for other people and companies, which neither install covers.

The operator decided on three editions on 2026-11-21.

## Decision

**Three editions, one codebase.** The server's `EDITION` setting chooses one:

| | Personal | Business | Hosted |
|---|---|---|---|
| Who runs the server | The person | The company | The operator ("global") |
| Accounts | **Exactly one**: the owner, who is also the admin | The company's people | Personal accounts and business tenants |
| Joining | Nobody else can join | The company's admins invite | The operator invites; a tenant's admins invite their people |
| Organizations | None | **One, the company**, created at setup; every account is a member | One per business tenant, isolated from the others |
| Admin panel | Server only: backups, updates, mail, security | Company console: users, groups, collections, permission sets, policies, audit | Operator console (tenants, service desk, website, staff); each tenant gets the business console, scoped to it |
| Service desk | No | Internal IT help | Yes, for the operator's customers |
| Website editor | No | No | Yes |
| Emergency access, sharing with a person | No (there is no second account) | Inside the company | Inside a tenant, and between personal accounts |
| Share links, extension, backups, import, health | Yes | Yes | Yes |

The features themselves are the same code in every edition, as are the crypto, the storage, the
upgrades and the tests. An edition decides which features exist on a server, which menus and
setup steps appear, and which defaults apply.

**Enforced by the server, not only hidden.** Each gated route checks the edition and answers
404 `not_in_edition` when the feature is off, so a hidden menu cannot be reached by URL either.
`/api/instance` reports the edition, and the web app and the extension shape themselves from it.

**Install profiles map to editions.** The *personal* profile sets `EDITION=personal`, and the
*business* profile sets `EDITION=business`. The reference instance runs `hosted`. An unset
`EDITION` on an existing server keeps today's behaviour, which is `hosted` with every feature on,
so no upgrade breaks a running install.

**Changing edition.** Moving up, from personal to business or hosted, or from business to hosted,
is a setting change. The data already fits. Moving down is refused while the server holds what
the smaller edition cannot have: a second account, or more than one organization.

## Personal edition

- Setup creates the owner account, then goes straight to the vault. There is no registration
  mode to choose and no invitations.
- The admin panel becomes **Server**: backups, updates, mail (optional, for alerts), sign-in
  rules for the one account, and the server's own audit and health.
- Organizations, groups, collections, the service desk, the website editor, staff roles, emergency
  access and "share with a person" are absent from the UI and refused by the API.
- The documentation is an install guide and a runbook written for one person, not an operator.

## Business edition

- Setup creates the owner and **the company**: one organization, named at setup, with its
  recovery key (0026). Everyone who joins becomes a member and appears for an admin to confirm.
  Confirming by fingerprint is unchanged (0009, 0025), because the server cannot hand out keys.
- One admin console, replacing the separate "Organizations" page and the admin panel's users
  and invitations:
  - users, with their status and their devices;
  - groups;
  - collections;
  - **permission sets**, named bundles of collection permissions given to groups or people;
  - policies, audit and the service desk.
- Feature reference: Zoho Vault and 1Password Business, compared item by item when this stage
  is built, as phase 3.5 did.

## Hosted edition

- The operator's own server. People join by invitation. A business signs up as a **tenant**: an
  organization with its own admins, members, policies and audit, invisible to other tenants and to
  personal accounts.
- The operator console manages tenants and personal accounts, the service desk, the website and
  staff roles. Tenant admins get the business console, scoped to their tenant.
- The operator still never holds a key. Tenants are organizations in the 0015 sense, with their
  keys sealed to their own members.

## Stages

1. **Editions and the personal edition**: the setting, server-side gating, `/api/instance`, the
   web app shaped by it, personal setup and admin panel, personal install guide and runbook.
2. **Business edition**: one company per server, the unified admin console, permission sets, the
   Zoho/1Password comparison.
3. **Hosted edition**: tenants, the operator console, tenant-scoped admin consoles.

## Consequences

- The README and ROADMAP stop saying "no separate editions". 0010's other commitments stand:
  configuration over code, installable and upgradable packages, nothing phoning home.
- Every new feature now states which editions have it, and its tests run in each of those.
- Running a hosted service means holding other people's encrypted data. That is a responsibility
  the self-hosted editions never put on the operator: uptime, backups, abuse, and terms of
  service. It is noted here and planned with stage 3.
