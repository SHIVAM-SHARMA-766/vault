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

**Oracle NoSQL Database Cloud Service, one table, no secondary indexes.**

Its always-free allowance is 133 million reads and 133 million writes a month across
three tables of 25 GB each. It is a managed service, so the data survives the instance.

| Shard key (`pk`) | Sort key (`sk`) | Holds |
|---|---|---|
| `USER#<userId>` | `PROFILE` | KDF parameters, auth verifier, both wrapped Vault Keys |
| `USER#<userId>` | `ENTRY#<entryId>` | One encrypted entry blob |
| `USER#<userId>` | `FOLDER#<folderId>` | Encrypted folder name and parent |
| `USER#<userId>` | `HIST#<entryId>#<ts>` | Prior versions, capped at twenty |
| `USER#<userId>` | `ACT#<ts>#<rand>` | Activity record, with a row-level expiry |
| `USER#<userId>` | `SESSION#<tokenId>` | A live refresh token, with an expiry |
| `EMAIL#<hmac>` | `EMAIL` | Login pointer to a user id |

Loading the vault is one query on the shard key. Login is one point lookup on the email
pointer. There are no secondary indexes, because there is no query that needs one — the
only two reads are those.

The sort-key prefixes give range queries for free: `HIST#<entryId>#` returns one entry's
history in order, and `ACT#` returns the activity log newest-first without an index.

### One JSON column, not a schema

The table has three columns: `pk`, `sk`, and `data`. Everything an item carries lives in
`data` as JSON. Giving the server a typed schema would be a schema it could not enforce,
because it cannot read what the columns contain.

### Rows expire themselves

Activity records and sessions are written with a row-level time to live. Oracle NoSQL
removes them at no charge, so neither can grow without bound and there is no pruning
code to forget to run.

### Email addresses are never stored in the clear

The login pointer is keyed by `HMAC-SHA256(server_pepper, normalized_email)`. A dump of
the table reveals how many accounts exist and nothing about whose. The pepper lives
outside the table.

### Backups go to Object Storage

An export of the table is written to a private bucket on a schedule. The exported rows
are ciphertext the server holds no key for, so a leaked export is no worse than a leaked
table.

## Rejected

**Anything on the instance's own disk** — PostgreSQL, SQLite, a file. The instance can be
reclaimed for being idle. Storage that dies with it is the one thing this design cannot
accept.

**Provisioned capacity above the free allowance, or on-demand mode.** Provisioned at the
free rate, a flood throttles rather than bills. Throttling is the intended behaviour: it
is what keeps the cost at zero.

**Any secondary index.** Each one consumes part of the same allowance, and no access
pattern requires one.

**Storing the whole vault as one encrypted row.** Genuinely attractive: every write
becomes atomic and nothing about the structure leaks, not even how many entries exist.
Rejected on the row size limit, which is a hard ceiling, and because every edit would
rewrite and re-transfer the entire vault.

**Plaintext names and tags to enable server-side search.** See
[0001](0001-cryptography-and-key-hierarchy.md). The client-side alternative costs nothing
at this scale.

**DynamoDB.** This ran on DynamoDB first; see [0003](0003-running-everything-on-oci.md)
for why the platform changed. The data model survived the move nearly unchanged, which is
the main argument that it was shaped around the access pattern rather than around one
vendor.

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

**Capacity is a ceiling, not a target.** A bulk import must be batched and rate-limited
rather than fired in parallel, or it will throttle.

**A table dump reveals structure but not content:** how many accounts exist, how many
entries and folders each has, and when each was created and changed. Closing that last
gap would require the single-row model rejected above.
