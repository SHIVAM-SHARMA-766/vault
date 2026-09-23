# 0002 — Storage and data model

Status: Accepted
Date: 2026-09-22

## Context

The vault needs durable storage that stays inside a permanently free allowance and
outlives the machine serving it. That second requirement is not theoretical: the
instance this runs on is an always-free one, and Oracle's terms permit reclaiming an
idle always-free instance. If the data lived on its disk, a reclamation would take the
vault with it.

The access pattern is unusually simple. The vault is single-user, the client holds the
decryption key, and all metadata is encrypted ([0001](0001-cryptography-and-key-hierarchy.md)).
The server cannot filter, sort, or search on anything meaningful, so it does not try. The
only read the application performs is *"return everything belonging to this user."*

## Decision

**MySQL HeatWave, one table, one primary key.**

Its always-free allowance is a single-node system with 50 GB of storage, and it is a
managed service, so the data survives the instance. It sits inside this project's own
network with no public address, so it is not reachable from the internet at all.

The choice was narrower than it looks. Oracle NoSQL would have been the closer fit for a
key-value model, and it is what this was first written against — but this tenancy cannot
create a NoSQL table at all. Its limits are `read-unit-count 0`, `write-unit-count 0`,
`table-size-gb 0`, and a create is refused with *"read units of 50 exceeds the maximum
allowed per tenant of 0"*. The documented always-free allowance does not exist here.

| `pk` | `sk` | Holds |
|---|---|---|
| `USER#<userId>` | `PROFILE` | KDF parameters, auth verifier, both wrapped Vault Keys |
| `USER#<userId>` | `ENTRY#<entryId>` | One encrypted entry blob |
| `USER#<userId>` | `FOLDER#<folderId>` | Encrypted folder name and parent |
| `USER#<userId>` | `HIST#<entryId>#<ts>` | Prior versions, capped at twenty |
| `USER#<userId>` | `ACT#<ts>#<rand>` | Activity record, with a row-level expiry |
| `USER#<userId>` | `SESSION#<tokenId>` | A live refresh token, with an expiry |
| `EMAIL#<hmac>` | `EMAIL` | Login pointer to a user id |

The primary key is `(pk, sk)` in that order. Loading the vault is one range scan over a
single `pk`; login is one point lookup on the email pointer. Both are covered by the
primary key, so neither reads a row it does not return, and there are no secondary
indexes because no third query exists.

The sort-key prefixes give range queries for free: `HIST#<entryId>#` returns one entry's
history in order, and `ACT#` returns the activity log without an index or a sort.

### One JSON column, not a schema

The table has three meaningful columns: `pk`, `sk`, and a `data` JSON document.
Everything an item carries lives in `data`. Giving the server a typed schema would be a
schema it could not enforce, because it cannot read what the columns contain.

### Rows expire themselves

Sessions and activity records carry an `expires_at` column — outside the JSON document,
and indexed — and a scheduled event removes them every fifteen minutes. MySQL has no
per-row time to live, so this replaces one. Neither can grow without bound, and nothing
depends on an operator remembering to prune.

### Email addresses are never stored in the clear

The login pointer is keyed by `HMAC-SHA256(server_pepper, normalized_email)`. A dump of
the table reveals how many accounts exist and nothing about whose. The pepper lives
outside the table.

### Backups go to Object Storage, and are the only backup

An export of the table is written to a private bucket on a schedule. The exported rows
are ciphertext the server holds no key for, so a leaked export is no worse than a leaked
table.

**This is not a second line of defence; it is the only one.** The always-free tier refuses
a managed backup policy outright — *"Cannot specify backup policy with 'CreateDbSystem'
operation for an Always Free DB system"* — so there is no automatic snapshot behind it. If
the export stops running, there is no backup.

## Rejected

**Anything on the instance's own disk** — PostgreSQL, SQLite, a file. The instance can be
reclaimed for being idle. Storage that dies with it is the one thing this design cannot
accept.

**Oracle NoSQL.** The better fit on paper and the original choice. This tenancy's NoSQL
limits are zero on every axis, so it cannot be used at all.

**Autonomous Database.** Available here — the tenancy allows two — and rejected on its
inactivity policy: *"After being inactive for 7 days, the database will be stopped
automatically"*, and a database stopped for ninety cumulative days *"may be reclaimed and
permanently deleted"*. A vault nobody opened this week should not be a vault that is down,
and one nobody opened this quarter should not be a vault that is gone.

**Any secondary index.** No access pattern requires one, and each would be maintained on
every write for nothing.

**Storing the whole vault as one encrypted row.** Genuinely attractive: every write
becomes atomic and nothing about the structure leaks, not even how many entries exist.
Rejected on the row size limit, which is a hard ceiling, and because every edit would
rewrite and re-transfer the entire vault.

**Plaintext names and tags to enable server-side search.** See
[0001](0001-cryptography-and-key-hierarchy.md). The client-side alternative costs nothing
at this scale.

**DynamoDB.** This was written for DynamoDB first; see
[0003](0003-running-everything-on-oci.md) for why the platform changed. The model has now
survived two moves — DynamoDB, then Oracle NoSQL, then MySQL — without its shape changing,
which is the strongest evidence that it was built around the access pattern rather than
around a vendor. Each move changed one file: the storage adapter behind a five-method
interface.

## Consequences

**The client loads the entire vault on unlock.** One query, then everything happens in
memory. At a few hundred entries that is a single request; past that, pagination is the
first thing to add.

**There is no server-side search, sort, or filter.** All of it is client work. This
follows from the encryption boundary and is not a gap to be closed later.

**Referential integrity is the application's job.** Deleting a folder must reassign or
delete its entries in client-issued writes. An interrupted delete can leave an entry
pointing at a folder that no longer exists, so the client treats an unresolvable folder
id as "unfiled" rather than as an error.

**The connection pool is small on purpose.** One user on a one-core host needs a handful
of connections; a large pool would hold connections the database counts against its own
limits and buy nothing.

**Rate-limit counters are a single statement.** `INSERT ... ON DUPLICATE KEY UPDATE`
increments atomically in the database, so the counter cannot lose a race — which the
key-value version had to handle with a compare-and-set retry loop. This is one of the few
places where the relational store is simply better.

**A table dump reveals structure but not content:** how many accounts exist, how many
entries and folders each has, and when each was created and changed. Closing that last
gap would require the single-row model rejected above.
