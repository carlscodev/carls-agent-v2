---
name: refactoring
description: Refactor safely: small steps, seams, characterisation tests, and removing duplication without breaking behaviour.
version: 1
when_to_use: Use when restructuring existing code, untangling a large function, or before adding a feature to messy code.
tags: [refactoring legacy duplication extract rename seams tests behaviour]
---
# Refactoring

## Rule zero

Change structure and change behaviour in separate steps. Never mix a refactor
with a feature in one commit; the diff becomes unreviewable and the tests cannot
tell you which change broke what.

## Before you touch anything

- Get the code under test. If there are no tests, write characterisation tests
  that pin the *current* behaviour, including the weird parts, before changing it.
- Run the suite and record what passes. You need a known-good baseline.
- Note the public surface you must preserve.

## Small steps

- Extract a function, run the tests, commit. Extract a variable, run, commit.
  A refactor that takes an hour without running tests is a rewrite.
- Rename to reveal intent as you go. Names are the cheapest documentation.
- Delete duplication only when the two copies change together. Premature
  abstraction is worse than duplication.

## Techniques that pay off

- Replace a long `if/else` chain over a type with polymorphism or a lookup table.
- Introduce a seam (a parameter, an interface) so a dependency can be substituted.
- Replace a flag argument with two functions.
- Move behaviour next to the data it needs; keep dependencies pointing inward.
- Make illegal states unrepresentable with types instead of runtime checks.

## When to stop

- Stop when the next change becomes easy to make safely. Do not refactor toward
  an imagined ideal architecture.
- If the refactor keeps growing, you mis-scoped it. Land what is done, re-plan.

## Verify

Type check, full test suite, and a real run of the affected path. Then read the
diff as a stranger: every change should be explainable in one sentence.
