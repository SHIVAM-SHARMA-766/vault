# 0016 — Completing teams: rotation, groups, policies, audit, emergency access

Status: Accepted
Date: 2026-11-07
Builds: [0015](0015-organizations-and-collections.md)

## Decision

**Key rotation.** A member with *manage* rotates a collection in their browser: new key at
version n+1, every item re-encrypted, the key sealed to every remaining grantee, sent in one
request. The server accepts it only if the grants and items match exactly what it holds (409
otherwise; the client retries), so nothing stays readable only under the retired key. Removing a
member, revoking a grant or removing someone from a group marks collections `rotationNeeded`;
the admin's client then rotates automatically where it can manage, and a **Rotate key** button
covers the rest.

**Groups** are named sets of confirmed members, their names sealed under the org key. Granting a
collection to a group seals its key to each member in that request (the server refuses if any
member is missing a sealed copy). Adding someone to a group is followed by their client-side
grants for that group's collections the acting admin can manage; removing someone revokes the
grants that came through the group and marks rotation.

**Policies**, per organization, apply to everyone in it, admins included:

| Policy | Enforced by | Strength |
|---|---|---|
| Two-factor sign-in required | the server (it knows) | real |
| Minimum master password strength | the server, on a score the member's app reports at unlock and password change | self-reported — the server never sees a master password; a modified app could lie |
| Idle lock | each member's app | client-side |

Members who do not meet a policy are refused the organization's collections (`policy_required`)
until they do.

**Access audit.** Per organization, kept a year: writes, deletes, grants, confirmations,
removals, rotations and policy changes are recorded by the server as they happen; opening,
revealing and copying a shared item happen only in the app, which reports them, and the log
marks those "reported by app".

**Emergency access** between people: the grantor names a contact and a waiting period (1–30
days); the contact accepts; the grantor confirms their fingerprint and seals **their vault key**
to the contact. On request, the grantor can approve or reject; if they do nothing, access opens
when the wait has passed. The contact gets a read-only view of the grantor's sealed entries.
The server enforces the wait and could release the sealed key early if it colluded with the
contact — the trust any server-enforced delay requires (threat A14). The vault key never
rotates, so revoking stops future access but cannot recall a key already opened.

**Organization recovery is not built.** It would mean sealing members' keys to an organization
key, weakening the guarantee for everyone in it; it stays an open decision for phase 3.5.

**Operator view.** The server operator's admin panel lists organizations by counts and the
display name their creator typed, and can delete one (audited). It never receives sealed blobs.
