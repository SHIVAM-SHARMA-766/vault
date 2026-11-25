# 0033: The hosted edition — companies as invited tenants

Status: Accepted by the operator on 2026-11-25; built
Date: 2026-11-25
Implements: [0030](0030-editions.md) stage 3. Builds on [0031](0031-two-workspaces.md) and [0032](0032-business-edition.md).

## Context

0030 made the hosted edition the operator's own server, "global", for personal accounts and for
companies as tenants. Before this decision, any account on such a server could create an
organization. The operator chose that **companies are invited**: the operator invites a company's
admin, who then creates the company and runs it.

## Decision

**A company invitation.** In the console's server scope, the organizations list becomes
**Tenants** and has **Invite a company**: a company name and an optional address. It issues a
single-use code (14 days by default), emailed when mail is set up and shown once otherwise. The
account that signs up with it may create **one** company. The grant is used up on creation, and
it is claimed even while registration is open, so it is never lost.

**Who may create a company** on a hosted server:
- the server's owner and admins;
- an account holding an unused company invitation.

Anyone else is refused (403 "Companies on this server are invited by its operator"). Their
My organizations shows why. Sharing one item with one person (a direct share, D11) stays open
to everyone. Organizations that already exist are untouched. `/api/auth/me` reports
`canCreateCompany`.

**A tenant runs itself** from its Admin console: People, Groups, Collections, Password health,
Permission sets, Policies, Activity, Recovery. Its admins see only their own company. The
business edition's account list and *Add to company* belong to a company's own server and are not
shown here.

**Inviting into a tenant reveals nothing about other tenants.** On a hosted server, a tenant
admin's invitation always comes with a sign-up code, whether or not the address already has an
account. The business edition gives a code only for a new address, which is fine on a company's
own server, but would leak here.

**Only when set on purpose.** All of this applies when the operator sets `EDITION=hosted`.
`/api/instance` reports it as `companiesInvited`. An install that never set `EDITION` also runs
with every feature on (0030), and keeps letting anyone create an organization, exactly as before
editions. Upgrading never changes who may create one.

## The operator's responsibilities

Running Vault for other people and companies adds duties that the self-hosted editions never
put on anyone. Vault cannot discharge them in code:
- **Availability and backups.** Tenants depend on this server. Keep server backups off the
  machine (docs/INSTALL.md) and test restores.
- **Abuse.** Remove a tenant or account that misuses the service (Tenants → delete, Users →
  disable). This is audited. Nobody can read a tenant's data in order to judge it.
- **Terms.** Say what the service is, what it costs, how long data is kept after an account or
  company leaves, and how to export it (Import & export, organization backup).

These are noted here, not built.

## Tests

- API: a plain account is refused and can still make a direct share; the operator may create; a
  company invitation allows exactly one company and is listed as one; a tenant admin gets a code
  for any address; company invitations do not exist in business or personal.
- e2e: the operator invites Acme Corp, its admin signs up with the code and lands in Acme's
  console, a personal user sees why they cannot create one, and the tenant appears in the
  operator's list.
