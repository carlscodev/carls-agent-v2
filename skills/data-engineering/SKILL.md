---
name: data-engineering
description: Build data pipelines and analysis: ETL, schemas, idempotency, partitioning, and correctness checks.
version: 1
when_to_use: Use for ETL jobs, analytics queries, data models, or pipeline reliability work.
tags: [data etl pipeline analytics warehouse partitioning idempotency schema quality]
---
# Data engineering

## Pipelines

- Every step is idempotent: re-running it must not duplicate rows. Use a natural
  key with an upsert, or delete-and-insert for a partition.
- Partition by time for append-heavy data; the partition key must appear in the
  filter or the query scans everything.
- Make backfills a first-class operation, not a script someone runs by hand.
- Land raw data first (immutable), then transform. You cannot re-derive what you
  did not keep.

## Schema

- Declare types at the boundary and validate on ingest. A pipeline that accepts
  anything produces a warehouse nobody can query.
- Evolve schema additively. A renamed column is a breaking change for every
  downstream consumer.
- Separate the event time from the processing time; late-arriving data is normal,
  not exceptional.

## Correctness

- Row counts in and out, plus a checksum of a key column. Assert them and fail the
  job on a mismatch.
- Tests for the transformations: known input, expected output. Test the SQL, not
  just the orchestration.
- Watch for silently dropped rows on a join: a left join that turns into an inner
  join because of a filter in the `WHERE` clause is a classic bug.
- Deduplicate with a defined rule (latest by event time), not by luck.

## Queries and cost

- Partition pruning and column pruning first; they dominate every other tuning.
- Avoid `SELECT *` in pipelines; a new column upstream can break a downstream
  loader.
- Materialise expensive intermediate results rather than recomputing them in
  every downstream job.
- Know your cost model: scanned bytes, warehouse credits, or shuffle volume.

## Orchestration

- Explicit dependencies between tasks, not cron timing guesses.
- Alert on failure and on staleness (data did not arrive), not only on errors.
- Keep a small dataset for local development so the pipeline can be tested
  without the warehouse.
