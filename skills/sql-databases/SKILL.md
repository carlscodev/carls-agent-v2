---
name: sql-databases
description: Write and review SQL and database work: schema design, indexing, migrations, transactions and query tuning.
version: 1
when_to_use: Use for schema changes, slow queries, migrations or any SQL (Postgres, MySQL, SQLite).
tags: [sql postgres mysql sqlite database schema index migration query explain transaction]
---
# SQL and databases

## Schema

- Normalize to third normal form, then denormalize deliberately with a comment
  explaining the read pattern.
- Constraints in the database: `NOT NULL`, `UNIQUE`, `CHECK`, foreign keys. The
  database is the last line of defence and the only one that cannot be bypassed.
- Use a stable primary key (`bigint` identity or UUIDv7). Do not use a mutable
  natural key as the primary key.
- `timestamptz` in Postgres, never naive timestamps. Store UTC.
- Money as integer minor units or `numeric`, never `float`.

## Indexes

- Index the columns you filter and join on, in the order the query uses them.
  A composite index on `(a, b)` serves `a` and `a, b`, not `b` alone.
- Partial indexes for skewed predicates (`WHERE deleted_at IS NULL`).
- Every foreign key column needs an index; Postgres does not create one.
- Too many indexes slow writes. Audit unused ones with `pg_stat_user_indexes`.

## Queries

- `EXPLAIN (ANALYZE, BUFFERS)` before and after. Look for sequential scans on
  large tables, nested loops over big sets, and bad row estimates.
- Avoid `SELECT *` in application code; fetch the columns you use.
- `LIMIT` with an `ORDER BY` that an index supports, or the sort spills to disk.
- N+1 is the most common production bug: one query per row. Batch with `IN` or a
  join.

## Migrations

- Every migration is reversible, or explicitly marked irreversible with a reason.
- Never mix DDL and large data backfills in one migration; backfill in batches.
- Adding a NOT NULL column to a big table needs a default and a lock strategy.
- Create indexes concurrently (`CONCURRENTLY`) on live tables.

## Transactions

- Keep them short. Never hold a transaction open across a network call.
- Know your isolation level; default read-committed in Postgres is usually right.
- Retry serialization failures, do not swallow them.
