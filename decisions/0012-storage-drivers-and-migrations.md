# 0012 — Storage drivers and schema migrations

Status: Accepted
Date: 2026-11-07

## Context

Phase 2 makes Vault something a customer installs ([0010](0010-self-hosted-product.md)).
The reference instance runs MySQL HeatWave because OCI gives one away; a customer's choices
are different. Someone on a Raspberry Pi wants no database server at all. A company wants the
database its operations team already runs and backs up, most often PostgreSQL. The roadmap
listed "which databases" as an open decision.

The data model makes this cheap: one table of `(pk, sk, JSON document, expiry)`, reached only
through a five-method `Store` interface ([0002](0002-storage-and-data-model.md)), with a
contract test suite every implementation must pass.

## Decision

**Three drivers — SQLite, PostgreSQL and MySQL — chosen with `DB_DRIVER`, all held to one
contract suite, with versioned migrations that run on start.**

| Driver | For | Notes |
|---|---|---|
| `sqlite` | Personal installs: one container, one file | `better-sqlite3`; WAL mode; online backup API for consistent copies |
| `postgres` | Business installs, several app instances | `pg`; keys `COLLATE "C"`; migrations under an advisory lock |
| `mysql` | The reference instance; customers on MySQL 8 | `mysql2`; migrations under `GET_LOCK` |

- **Migrations** live in `services/api/src/storage/migrations.ts`, one list for every driver,
  numbered from 1. A `vault_meta` table records the version. Released versions are never
  edited or removed. A server refuses to start against a database newer than it understands,
  because an old server writing a newer schema is how data is damaged quietly. Version 1 uses
  `IF NOT EXISTS`, so it adopts tables created before migrations were versioned.
- **Expiry** is swept by the server every fifteen minutes for every driver (only MySQL has a
  scheduler). A row that outlives its expiry until the next sweep grants nothing: tokens carry their own expiry and rate windows are keyed by time.
- **Keys are exact** in every store. Writing the contract test for this found that the
  reference instance's MySQL table used a case-insensitive collation; migration 2 moves it to
  `utf8mb4_bin`. Going from insensitive to exact cannot create duplicates.
- **Drivers load lazily.** The single-file release bundle carries the pure-JavaScript clients
  and leaves the native SQLite module external; an install loads only the driver it uses.
- **MariaDB is not supported**: it lacks MySQL 8's collations and JSON behaviour. PostgreSQL
  or SQLite are the answer for anyone without MySQL 8.

## Consequences

- Every storage change is written three times and tested against three real databases in CI
  (MySQL 8.4 and PostgreSQL 16 as services, SQLite in process).
- Two new runtime dependencies, `pg` and `better-sqlite3`. The latter is native: the container
  image must install it for its own architecture rather than copy it from a build machine.
- Backups become per-driver: `mysqldump`, `pg_dump`, or SQLite's online backup. Phase 2's
  backup work wraps all three behind one encrypted export.
