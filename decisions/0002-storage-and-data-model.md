# 0002 — Storage and data model

Status: Accepted
Date: 2026-09-22

## Context

The vault needs durable storage that stays inside a permanently free tier. The cost
constraint is absolute: only S3 charges are acceptable, and every other service must sit
within an allowance that does not expire after twelve months.

DynamoDB's free tier is perpetual — 25 GB of storage and 25 provisioned read and write
capacity units, with no expiry — which is what places the vault there rather than on a
managed relational database. That choice is already recorded in the infrastructure
decision for workload placement; this document decides what the data actually looks like.

The prior implementation used PostgreSQL with six tables, foreign-key cascades, array and
JSONB columns, a case-insensitive uniqueness index, and multi-row transactions. None of
that translates. The model has to be rebuilt around DynamoDB's actual primitives, and the
honest starting point is the access pattern, not the old schema.

**The access pattern is unusually simple.** The vault is single-user, the client holds
the decryption key, and all metadata is encrypted (see [0001](0001-cryptography-and-key-hierarchy.md)).
The server cannot filter, sort, or search on anything meaningful, so it does not try. The
only read the application performs is *"return everything belonging to this user."*

## Decision

### One table, no secondary indexes

A single table named `vault`, on-demand disabled, provisioned at exactly 25 RCU and
25 WCU, with autoscaling off.

| PK | SK | Item |
|---|---|---|
| `USER#<userId>` | `PROFILE` | KDF salt and parameters, auth verifier, both wrapped Vault Keys |
| `USER#<userId>` | `ENTRY#<entryId>` | One encrypted entry blob, IV, timestamps |
| `USER#<userId>` | `FOLDER#<folderId>` | Encrypted folder name, parent id |
| `USER#<userId>` | `HIST#<entryId>#<ts>` | Encrypted prior version of an entry |
| `USER#<userId>` | `ACT#<ts>#<rand>` | Activity record, plus a TTL attribute |
| `EMAIL#<hmac>` | `EMAIL` | Pointer to `userId` — login lookup only |

Loading the vault is one `Query` on `PK = USER#<id>`. Login is one `GetItem` on the email
pointer. There are no Global Secondary Indexes, because there is no query that needs one —
and each GSI would consume its own provisioned capacity out of the same free allowance.

The sort key prefixes give range queries for free: `HIST#<entryId>#` returns one entry's
history in chronological order, and `ACT#` with `ScanIndexForward=false` returns the
activity log newest-first without an index or a sort.

### Encryption at rest, twice over

Application-layer encryption is the real boundary — the server stores ciphertext it has
no key for. DynamoDB's own encryption at rest with an AWS-owned key is enabled on top,
because it is free and there is no reason to decline it. It defends against a different
adversary (physical media, AWS-internal) and is not load-bearing.

### Email is never stored in the clear

The login pointer is keyed by `HMAC-SHA256(server_pepper, normalized_email)`. A dump of
the table reveals how many accounts exist and nothing about whose they are. The pepper
lives in SSM Parameter Store, so obtaining the table is not sufficient to test guesses
against it.

### Activity log expires itself

Every `ACT#` item carries a TTL attribute set 90 days out. DynamoDB deletes expired items
at no charge. The log never needs pruning code and cannot grow without bound.

### History is capped in the client

Twenty versions per entry. On write, the client deletes the oldest surplus keys in the
same batch. Enforced client-side because the server cannot tell one entry's history from
another's without reading keys it already has.

### Backups go to S3

Point-in-time recovery and DynamoDB on-demand backups are both billable and are therefore
not used. Instead a scheduled Lambda reads the table and writes a compressed, encrypted
export to S3 — the one service whose cost is accepted. The export is ciphertext already,
so a leaked backup is no worse than a leaked table.

## Rejected

**A relational database.** The managed Postgres free tiers that exist are 0.5 GB, expire,
or suspend the database when a monthly compute allowance is exhausted. They also pair
badly with Lambda, where connection pools are exhausted by concurrent cold starts.

**Multiple DynamoDB tables, one per entity.** The 25/25 free capacity is per account, not
per table, so splitting entities across tables divides the same allowance into smaller
pieces that cannot absorb each other's bursts. A single table with sort-key prefixes has
strictly more headroom.

**Any Global Secondary Index.** Each one carries its own provisioned capacity and would
have to come out of the same free allowance. No access pattern requires one: the only two
reads are a partition query and a point lookup.

**On-demand capacity mode.** Bills from the first request. Provisioned at exactly the
free-tier numbers, with autoscaling explicitly disabled, is the only configuration that
stays at zero. Autoscaling left on would silently scale past the allowance under load.

**Storing the whole vault as one encrypted blob.** Genuinely attractive: every write
becomes atomic, and nothing about the structure leaks — not even how many entries exist.
Rejected on the 400 KB item size limit, which is a hard ceiling with no path past it, and
because every edit would rewrite and re-transfer the entire vault.

**Plaintext names and tags to enable server-side search.** See [0001](0001-cryptography-and-key-hierarchy.md).
The client-side alternative costs nothing at this scale.

**Point-in-time recovery.** Billable, and the scheduled export to S3 covers the same
requirement within the accepted cost.

## Consequences

**The client loads the entire vault on unlock.** One query, then everything happens in
memory. At a few hundred entries this is a single request well under the 1 MB page limit;
past that, pagination is required and is the first thing to implement if the vault grows
unexpectedly large.

**There is no server-side search, sort, filter, or pagination by content.** All of it is
client work. This is a direct consequence of the encryption boundary and is not a gap to
be closed later.

**Referential integrity is the application's job.** No foreign keys and no cascades.
Deleting a folder must reassign or delete its entries in client-issued writes; an
interrupted delete can leave an entry pointing at a folder that no longer exists, so the
client treats an unresolvable folder id as "unfiled" rather than as an error.

**Individual entries are capped at 400 KB.** Ciphertext expands slightly over plaintext,
so the practical limit on a single entry's notes is a little under that. The client must
reject oversized entries with a clear message rather than letting the write fail.

**Capacity is a hard ceiling, not a soft one.** At 25 WCU, a bulk import writes at roughly
25 items per second. Imports must be batched and rate-limited rather than fired in
parallel, or they will throttle. Throttling is the correct behaviour here — it is what
keeps the bill at zero.

**A table dump reveals structure but not content:** the number of accounts, the number of
entries and folders per account, and when each was created and last changed. Closing that
last gap would require the single-blob model rejected above. Accepted, and recorded in the
threat model.
