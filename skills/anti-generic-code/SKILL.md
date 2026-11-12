---
name: anti-generic-code
description: Rules for code that reads as deliberate engineering rather than generated filler.
version: 1
when_to_use: Use when writing or reviewing code in any language, to keep quality and specificity high.
tags: [code quality review style naming comments refactor standards]
---
# Code that does not look generated

## Naming

- Names carry meaning: `resolveApiKey`, not `helper2`. A reader should predict
  the body from the signature.
- No `data`, `info`, `temp`, `result2`, `handleStuff`. If the name is vague, the
  design is vague.
- Booleans read as predicates: `isDirty`, `hasAccess`, `canRetry`.

## Comments

- Explain *why*, never *what*. `// retry twice: the registry flakes under load`
  is useful; `// increment i` is noise.
- Never narrate the diff or the change history in a comment.
- Document non-obvious invariants, deliberate trade-offs and workarounds.

## Structure

- Small functions with one reason to change.
- Dependencies point inward. Business logic does not import the CLI.
- Return values, not flags: prefer `{ ok, output, error }` to a boolean plus an
  out-parameter.
- Handle the error at the level that can act on it; do not swallow it silently.
- No dead code, no commented-out blocks, no `TODO` shipped.

## Honesty

- Do not claim a behavior works without running it.
- Tests assert behavior, not implementation detail. No mocks when the real path
  is cheap to exercise.
- If something is untested, say so plainly.

## Review pass

Read the diff as a stranger. Every line should have an obvious reason to exist.
Delete anything that only exists because a generator would emit it.
