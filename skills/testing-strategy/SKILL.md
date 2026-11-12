---
name: testing-strategy
description: Design and write tests that catch real bugs: pyramid, fixtures, flakiness, coverage and CI.
version: 1
when_to_use: Use when adding tests, fixing flaky suites, or deciding what to test.
tags: [testing unit integration e2e tdd fixtures flaky coverage ci]
---
# Testing strategy

## Shape

- Many fast unit tests, fewer integration tests, a handful of end-to-end tests.
- Test behaviour through the public interface. A test that breaks when you rename
  a private method is testing the wrong thing.
- One assertion concept per test. Multiple `expect`s on one result are fine;
  multiple unrelated behaviours are not.

## What to test

- Every bug you fix gets a regression test that fails before the fix.
- Boundaries: empty, one, many, negative, maximum, unicode, null.
- Error paths, not just the happy path. Assert the error type and message shape.
- Concurrency and ordering where they matter.

## What not to do

- No mocks of the thing under test. Prefer the real implementation.
- Avoid asserting on log text or exact string formatting that will churn.
- Do not chase 100% coverage; chase untested branches in critical paths.
- Never `sleep` to wait for async. Poll with a deadline, or await a signal.

## Fixtures and isolation

- Each test owns its data: a temp directory, a transaction rolled back, a unique
  namespace. No shared mutable state between tests.
- Tests must pass in any order and in parallel.
- Seed randomness explicitly; a test that fails 1 in 50 runs is a bug, not noise.

## Flakiness

Treat a flaky test as a production incident: it destroys trust in the suite.
Find the race or the shared state. Do not add retries to hide it.

## CI

- Run the full suite on every change; keep it under a few minutes.
- Report failures with the command to reproduce and the relevant output.
- Cache dependencies, not build artifacts you cannot trust.
