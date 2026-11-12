---
name: ruby
description: Write and review Ruby and Rails: idioms, blocks, metaprogramming, testing and performance.
version: 1
when_to_use: Use for .rb work, Rails applications, gems or RSpec suites.
tags: [ruby rails rspec gem blocks metaprogramming performance activerecord]
---
# Ruby and Rails

## Idioms

- Everything is an object; use that. `map`/`select`/`reduce` over `each` with an
  accumulator.
- Guard clauses over nested conditionals. Return early.
- `freeze` string literals with a magic comment or use frozen string literal
  defaults. Prefer `# frozen_string_literal: true`.
- Keyword arguments for anything with more than two parameters.
- `Struct`/`Data` (3.2+) for value objects instead of bare hashes.

## Methods and blocks

- Blocks for resource scoping and callbacks; procs for stored callables.
- `yield` and `block_given?` are fine, but `&blk` with `blk.call` is clearer when
  you store it.
- Metaprogramming: `define_method` over `method_missing`. If you need
  `method_missing`, also define `respond_to_missing?`.
- Never `eval` on input. `send` with a whitelist only.

## Rails

- Skinny controllers, fat models is also wrong: put complex rules in
  service objects or form objects.
- N+1 is the default failure: `includes`/`preload` and watch the logs.
- Database-level constraints (not-null, unique indexes, foreign keys) even when
  validations exist. Validations are UX; constraints are truth.
- Background jobs for anything slower than a request budget. Idempotent jobs.
- Strong parameters always. Never `params.permit!`.

## Performance

- Measure with `benchmark-ips` or a profiler; Ruby is slow, so the constant
  factor matters.
- Avoid building large intermediate arrays; stream with `find_each`.
- Cache with a real key strategy and an expiry. No cache without invalidation.

## Testing

- RSpec with `let`, `subject` used sparingly, and request specs for endpoints.
- FactoryBot over fixtures for anything with logic. `build_stubbed` when you do
  not need the database.
