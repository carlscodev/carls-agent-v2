# AGENTS.md

Instructions for the coding agent working in this repository. It is read into the
system prompt on every turn, so it is the cheapest way to change how the agent
behaves. Edit it to match your project.

Project internals live in `docs/` — do not paste them here:

- [docs/architecture.md](docs/architecture.md) — request lifecycle, compaction,
  sub-agents, interface invariants, module map
- [docs/configuration.md](docs/configuration.md) — every config key
- [docs/tools.md](docs/tools.md) — tool catalog
- [docs/cli.md](docs/cli.md) — flags, keybindings, commands
- [docs/parity.md](docs/parity.md) — what exists and what does not

## What this project is

`carls-code` is an autonomous coding agent that runs in a terminal: strict
TypeScript, native ESM, Node.js 20+. It gathers context, makes minimal edits,
then runs the project's own verification until it passes. There is no runtime
dependency on a framework — keep it that way.

## Commands

```bash
npm install
npm run typecheck   # tsc --noEmit, strict + exactOptionalPropertyTypes
npm test            # vitest
npm run build       # tsc -> dist/
npm run dev         # run from source
node ./bin/carls.mjs --help   # requires npm run build first
```

## How to work in this repository

1. Read `docs/architecture.md` before changing `src/core/` or `src/cli/`.
2. Search before reading: `grep_search` and `glob_files` beat opening whole files.
3. Change the contract first (`src/types/`), then the implementations.
4. Never claim success without running `npm run typecheck && npm test`.
5. Finish with what you verified and what you could not verify.

## Non-negotiables

- **stdout is the model's answer.** Every diagnostic, spinner, tool stream and
  permission prompt goes to stderr, so `carls -p "…" | jq` keeps working.
- **Tools never throw.** Return `{ ok: false, error }`; `bash` reports a non-zero
  exit code as data.
- **Tool schemas come from zod**, never hand-written twice.
- **Compaction cuts at a tool-pair boundary.** A `tool_result` separated from its
  `tool_use` makes the provider reject the request.
- **Terminal width is a correctness property.** Measure with `src/cli/Text.ts`,
  never count escape sequences, and never emit a line wider than the terminal.
- **File tools stay inside the workspace** unless `allowOutsideWorkspace` is set.
- **No secrets in the repo.** Keys come from the environment or the config file,
  and `Logger.redact` runs before anything reaches a log or the model.

## Style

- Match the surrounding code; early returns over nesting.
- A comment explains *why*, never *what*.
- No new dependency without a strong reason; the tree is small on purpose.
- Tests live in `tests/smoke.test.ts` and exercise real code paths: real
  filesystem, real `bash`, a scripted in-process provider for `AgentLoop`.

## Definition of done

- `npm run typecheck` clean, `npm test` green, `npm run build` if `dist/` matters.
- New behaviour is covered by a test.
- Docs updated when a flag, config key or tool changes.
- Nothing committed that you would not want published.
