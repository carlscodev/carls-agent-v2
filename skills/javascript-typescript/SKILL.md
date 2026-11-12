---
name: javascript-typescript
description: Write and review modern JavaScript and TypeScript: types, modules, async, tooling and build output.
version: 1
when_to_use: Use for any .ts/.js/.mjs work, Node services, CLIs, bundlers or type errors.
tags: [javascript typescript node esm types async bundler tooling tsc]
---
# JavaScript and TypeScript

## Types

- `strict: true`, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`
  when the project tolerates them. Index access returns `T | undefined`; treat it
  that way instead of asserting.
- Model absence explicitly: `effort: Effort | undefined` beats `effort?: Effort`
  when you must always decide a value.
- Prefer discriminated unions over optional-field soup. A `status: "ok" | "error"`
  with a matching payload is self-checking.
- Never `as any` to silence an error. Use `unknown` at boundaries and narrow with
  a type guard. If you must cast, cast to the narrowest type and say why.
- Use `satisfies` to keep literal inference while still checking a shape.

## Modules and runtime

- ESM only in new code: `"type": "module"`, explicit `.js` extensions in relative
  imports, `node:` prefixes for builtins.
- Node 20+: `node --test`, `structuredClone`, `AbortSignal.timeout`, top-level
  await. Do not hand-roll what the runtime provides.
- Never `require` inside ESM. For CJS-only packages, import the default and
  destructure, or use `createRequire`.

## Async

- `async` functions always return a promise; do not wrap in `new Promise`.
- Propagate cancellation: take an `AbortSignal`, pass it to `fetch` and to child
  processes, and check `signal.aborted` before expensive steps.
- Bound concurrency. `Promise.all` over 10k items opens 10k sockets. Use a small
  pool or `p-limit`.
- Never `await` inside a loop when the iterations are independent; collect and
  `Promise.all` them.

## Errors

- Throw `Error` subclasses, not strings. Preserve the cause: `new Error(msg, { cause })`.
- One error type per failure domain (config error, API error) so callers can act.
- Fail fast on programmer error; return a result object for expected failure.

## Verify

`npx tsc --noEmit`, then the test runner, then a real invocation. A type check
that passes is not evidence the feature works.
