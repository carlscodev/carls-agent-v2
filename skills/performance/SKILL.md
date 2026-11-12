---
name: performance
description: Find and fix performance problems: measurement, profiling, complexity, caching and latency budgets.
version: 1
when_to_use: Use when something is slow, or before optimising anything.
tags: [performance profiling latency throughput optimization complexity caching benchmark]
---
# Performance

## Measure first

- Never optimise from intuition. Profile, or at least time the operation with
  real data volumes.
- Establish a baseline number and a target. "Faster" is not a target; "p95 under
  200ms at 1000 rps" is.
- Benchmark the whole path, not a microbenchmark of the function you suspect.

## Find the bottleneck

- Latency budget per layer: network, database, serialisation, compute, render.
  The biggest slice is where to work.
- Profile CPU (`perf`, `py-spy`, `async-profiler`, `--cpu-prof`) and allocation.
  Most time is in a handful of frames.
- For I/O-bound work, the fix is concurrency or batching, not a faster loop.
- Look for N+1 queries and chatty calls before touching algorithms.

## Common wins

- Algorithmic: replace O(n^2) scans with a hash map. That beats micro-tuning
  every time.
- Batch: one query for 100 rows, not 100 queries. One bulk write, not 100.
- Cache with a correct key and an invalidation story. Measure the hit rate.
- Avoid needless work: skip unchanged inputs, memoise pure functions, stream
  instead of buffering.
- Reduce data: fewer columns, smaller payloads, compression, pagination.

## Do not

- Do not add a cache to hide a slow query; fix the query.
- Do not parallelise a CPU-bound loop in a language with a global lock.
- Do not optimise code that runs once at startup.
- Do not keep a change that trades readability for an unmeasured gain.

## Prove it

Report before/after numbers with the same input and the command used. A change
without a measurement is a guess.
