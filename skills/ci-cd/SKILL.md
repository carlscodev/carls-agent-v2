---
name: ci-cd
description: Design CI/CD pipelines: stages, caching, matrix builds, secrets, artifacts and fast feedback.
version: 1
when_to_use: Use when writing or debugging CI workflows, or improving pipeline speed and reliability.
tags: [ci cd pipeline github actions workflow cache matrix secrets deploy artifacts]
---
# CI/CD

## Stages

Order by cost: format/lint, type check, unit tests, build, integration tests,
deploy. Fail fast so cheap checks run first.

- Every stage must be reproducible locally with one command. Document it in the
  README.
- Required checks block the merge; optional checks inform.

## Speed

- Cache dependencies keyed on the lockfile hash, not the branch.
- Cache build output only when the compiler is incremental and correct; a stale
  cache that hides a failure is worse than a slow build.
- Shard the test suite across runners when it exceeds a few minutes.
- Do not reinstall tools per step; install once per job.

## Reliability

- Pin action and tool versions. `@v4` floats; a tag can move under you.
- Retry only network-bound steps, with backoff and a cap. Never retry tests to
  hide flakiness.
- Timeouts on every job. A hung job burns runner minutes forever.
- Concurrency groups cancel superseded runs on the same branch.

## Secrets

- Secrets come from the platform secret store, never the repository. Never echo
  them; mask derived values too.
- Least privilege: a test job does not need deploy credentials.
- Prefer short-lived OIDC tokens over long-lived cloud keys.
- A pull request from a fork must not receive secrets.

## Deployment

- Build the artifact once and promote the same artifact through environments.
  Rebuilding per environment means you ship something you did not test.
- Deploy immutably with a version or digest, not `latest`.
- Make rollback a single command, and test it before you need it.
- Gate production on the same tests that passed in staging.

## Debugging a failure

Read the failing step's full output, not the summary. Reproduce the exact
container locally. Check for environment differences (locale, timezone, file
permissions, missing env vars) before assuming the code is wrong.
