# 0006 — An admin panel that cannot read the vault

Status: Accepted, extended by [0007](0007-roles-and-site-editing.md) (roles beyond owner, website editing)
Date: 2026-11-06

## Context

Running the service meant SSH for everything an operator does: opening registration
(`scripts/registration.sh` edits a systemd drop-in and restarts the API), finding out how
many accounts exist, checking whether last night's backup ran. With SSH closed by default
([0005](0005-pull-based-releases.md)), each of those became a network change.

An admin panel in a zero-knowledge product has an unusual constraint: it must not become
the thing that breaks the zero-knowledge claim. The server holds no key for entry content
and stores email addresses only as HMAC digests, so there is nothing readable to show — and
the panel must not add anything that changes that.

## Decision

**Admin is a role on an ordinary account, granted by the server's configuration. The panel
manages accounts and service settings and can see only metadata the server already holds.**

### Who is an admin

`ADMIN_EMAILS` in `/srv/vault/api/run/secrets.env` lists the addresses. At start-up the API
turns them into digests with the server pepper and keeps only the digests; an account is an
admin when its profile's `emailDigest` is in that set. Signing in to the panel is the normal
zero-knowledge sign-in. There is no separate admin password, no admin token, and nothing an
attacker can obtain from the database to become one: the digest set lives in the process,
derived from configuration on the host.

Every `/api/admin/*` route re-reads the caller's profile and checks the digest; the client
hiding the panel from other accounts is a courtesy. Admin routes have their own rate limit.

### What it can do

| Area | Can | Cannot |
|---|---|---|
| Accounts | List with created, last sign-in, item and session counts; label; sign out everywhere; disable; delete | See an address, an entry, or an entry name; reset a password; unlock a vault |
| Registration | Set `closed`, `invite`, or `open` | — |
| Invitations | Create single-use codes with a label and an expiry; revoke | See a code after it is issued — only its hash is stored |
| Service | See the last recorded backup, uptime, server time | — |
| Audit | Read every admin action for the past year | Remove entries from it |

### Data

Everything lives in one new partition, `SYSTEM`, so listing across accounts is a partition
query and never a table scan (the constraint from [0002](0002-storage-and-data-model.md)):

| `sk` | Holds |
|---|---|
| `SETTINGS` | Registration mode. Absent or unreadable means `closed` |
| `USER#<id>` | Registry row: digest, created, last sign-in, label, disabled, invite used |
| `INVITE#<sha256(code)>` | Label, expiry, creator, used-at, used-by |
| `INVITEUSED#<sha256(code)>` | Marker written with a conditional insert, so a code is claimed once even under a race |
| `AUDIT#<ts>#<rand>` | Actor, action, target, detail. Expires after a year |
| `BACKUP` | Written by `vault-backup.sh` after a verified upload |

The audit record is written **before** the action, and a failure to write it stops the
action. Unlike user activity, an admin action that cannot be recorded does not happen.

### Behaviour worth knowing

- **Disabled accounts** are refused at login, recovery, and refresh, and disabling revokes
  every refresh token. Access tokens are not checked per request: they last fifteen
  minutes, so the window is bounded and every request is spared a read. A disabled account
  is refused only *after* its password is proved, so the response does not tell a stranger
  that the account exists.
- **The admin cannot disable or delete their own account**, so the panel cannot lock out
  the last person able to use it.
- **Deleting an account** removes its partition, its login pointer, and its registry row,
  and requires the account id in the request body as confirmation. It cannot be undone; the
  daily export is the only other copy.
- **`ALLOW_REGISTRATION=true`** still forces registration open. It exists to bootstrap the
  first account before anyone can reach the panel, and the panel warns while it is set.

## Consequences

**A compromised admin account can delete accounts and open registration.** It still cannot
read a vault. The account is protected by its master password, the per-address and per-IP
login limits, and the audit log; the admin should use a strong, unique master password and
treat that account accordingly.

**The operator identifies accounts by label, not address.** That is the cost of never
storing addresses. Invitations carry a label that is copied onto the account they create,
which covers the common case.

**Accounts created before this change have no registry row** and do not appear in the
panel. None existed when it shipped.
