# 0031: Two workspaces, My vault and the Admin console

Status: Accepted by the operator on 2026-11-22
Date: 2026-11-22
Relates to: [0030](0030-editions.md) (editions), [0015](0015-organizations-and-collections.md) (organizations)

## Context

An audit of every role's screens, with demo people in each, found administration and personal use
mixed together:

- **The Organizations page** was one long card per organization. It held the member list, the
  invite form, groups, collections, policies, activity, backup and the recovery key, one after
  the other.
- **Members saw admin material.** A member got the same page as the admin: every member, every
  group, and "Owners locked out?".
- **Two places to administer.** Running the server lived in the "Admin panel", while running a
  company lived in "Organizations". The account menu listed both beside the vault.
- **No sense of context.** Nothing showed whether you were administering, or which organization
  you were in.

The operator chose two workspaces over adding an "Administration" section to the vault's sidebar.

## Decision

**Two workspaces.** A switch in the top bar, *My vault* | *Admin console*, shown only to someone
who administers something.

- **My vault** is the same for everyone: their items, items shared with them, settings, and
  **My organizations**. My organizations is a member's view, with no admin controls. It shows:
  - the teams they belong to and what each requires;
  - the collections shared with them, with a way to ask for others;
  - invitations, their fingerprint, and starting an organization.
- **Admin console** has a **scope picker** labelled *Managing*:
  - **the server**, for staff roles. Its sections are the former admin panel: Overview, Users,
    Invitations, Service desk, Website, Audit log and System, as the edition allows (0030).
  - **each organization** where the person is owner or admin. Its sections are **Members**,
    **Groups**, **Collections** (with access requests), **Policies**, **Activity** and
    **Recovery & backup**.

The scope and the section are in the address (`/app/console/server/users`,
`/app/console/org/<id>/collections`), so reload, back and bookmarks work. `/app/admin/<tab>` still
opens the server scope. A notification an admin must act on opens the right section: someone
accepted an invitation goes to Members, and an access request to Collections.

**What stays in My vault.** A **direct share** ("Share with a person", D11) is a space between two
people, not an organization to run. Confirming the other person happens on its card in My
organizations, not in the console.

**Who sees the console.** Scopes come from the server (staff role) and from the organization list
(role owner or admin, confirmed, not direct). Someone with no scope never sees the switch, and
reaching `/app/console` tells them there is nothing to administer. The server still checks every
admin route; the console only decides what to show.

**Phones.** Below the width where the sidebar shows, the scope picker and the sections become a
bar of chips at the top of the console.

## Consequences

- The account menu names *My organizations* and *Admin console* (*Server settings* in a personal
  Vault, which has only the server scope).
- Organization screens are split into section components that the console composes. Members
  never load them.
- The browser tests reach admin screens through a `manage(page, org, section)` helper.
- The demo seed (`scripts/demo-seed.mjs`) works with both the old and the new layout, so it can
  fill a server before or after an upgrade.
