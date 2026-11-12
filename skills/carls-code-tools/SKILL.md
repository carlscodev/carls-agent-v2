---
name: carls-code-tools
description: Add a new tool the agent can call, with schema, permission category, tests and prompt wiring.
version: 1
when_to_use: Use when the agent needs a capability it does not have, such as fetching a URL, querying a database or rendering an image.
tags: [tool capability extend registry schema permission add function]
---
# Adding a tool to carls-code

## Checklist

1. Create `src/tools/<Name>.ts` implementing `Tool<Input>`:
   - `name` — snake_case, unique, short.
   - `description` — one sentence telling the model *when* to use it, not how.
   - `readOnly` and `category` (`read` | `write` | `shell`). Getting this wrong
     is a security bug: a `write` tool marked `read` bypasses the gate.
   - `schema()` — `zodToJsonSchema(inputSchema)`.
   - `parse()` — `inputSchema.parse(input)`, so bad model input fails loudly.
   - `run(input, ctx)` — return `{ ok, output }`; never throw for an expected
     failure. Put the message in `error` and let the loop feed it back.
2. Register it in `Runtime` (`src/core/Runtime.ts`), in the tool list.
3. If it needs services, add them to `ToolContext` in `src/types/tools.ts`
   rather than importing singletons.
4. Add a smoke test that runs the tool against a temp directory and asserts the
   returned `output` and `ok`.
5. If it changes user-visible behavior, mention it in the README.

## Quality bar

- Bound everything: timeouts on network and subprocess calls, line ranges on
  file reads, result caps on searches.
- Return the *observation*, not a success banner. The model needs data.
- Truncate huge output head+tail, and say how much was cut.
- Respect `ctx.signal` so Ctrl+C cancels a long tool.
- Snapshot before mutating a file: `ctx.backups?.save(path)`.
