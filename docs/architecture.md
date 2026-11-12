# Architecture

How carls-code is put together, and the invariants that keep it working. If you
only read one section, read **The turn** and **Interface invariants**.

## The turn

One user message becomes a loop of model calls:

```
user message
  └─ AgentLoop.run()
       ├─ shouldCompact()? → ContextManager.compact() → checkpoint message
       ├─ provider.complete(history, tools, system)
       ├─ no tool_use blocks? → done, return the text
       └─ tool_use blocks → execute → tool_result blocks → history → repeat
```

`AgentLoop` owns the loop, the tool timeout policy and the observation
truncation. It never throws on a tool failure: an error becomes a `tool_result`
with `is_error: true`, which the model can read and react to.

### Parallel read-only calls

Consecutive read-only tool calls issued in one turn run concurrently, capped by
`MAX_PARALLEL_TOOLS` (6). A call with a side effect (`write_file`, `edit_file`,
`bash`, `git_commit`, …) breaks the batch and runs alone and in order, so write
and shell ordering is unchanged.

`mapWithConcurrency` preserves the input order of the results, because each
`tool_result` must stay aligned with its `tool_use`, and `runToolUse` never
throws so one failed call cannot reject a whole batch.

## Context

`ContextManager` estimates the token budget (chars / 3.6, biased high) and
compacts at `compactThreshold` (default 0.75). Compaction keeps the last
`keepRecent` messages verbatim and folds everything older into a checkpoint:

```
[contexto compactado]
Objetivo: …
Progreso: …
Archivos tocados: …
Siguiente paso: …
```

The cut must land on a tool-pair boundary (`safeCutIndex` walks backwards past a
`tool_result`-only turn). A `tool_result` separated from its `tool_use` makes the
provider reject the request outright.

Long tool observations are truncated head+tail by `truncateObservation` before
they enter the history.

## Sub-agents

`delegate_task` runs a nested `AgentLoop` under `SubAgent`:

- read-only registry, `mode: "auto"`, its own 15-step budget;
- no `spawnSubAgent` in its tool context, which caps nesting;
- its conversation is discarded; only a JSON report
  (`summary`, `findings`, `relevantFiles`, `suggestedCommands`) returns.

## Providers

`src/providers/registry.ts` is the single source of truth: id, family,
protocol, base URL, credential variables, default and known models. Adding a
provider is one object there — the CLI, onboarding, `/doctor`, the model catalog
and `scripts/install.sh` all read it.

`createProvider` dispatches on the registry: `anthropic` protocol →
`AnthropicProvider`, everything else → `OpenAICompatProvider` (including Ollama's
`/v1` shim; native Ollama gets `OllamaProvider`, which reads the real context
window from the server). `retry.ts` classifies failures: transient statuses are
retried with backoff and `Retry-After`, client and billing errors are fatal and
never retried.

## MCP

`src/mcp/McpClient.ts` speaks the protocol (handshake, id correlation,
`tools/list`, `tools/call`); `src/mcp/transports.ts` owns the wire:

| Transport | Config | Framing |
| --- | --- | --- |
| `stdio` | `{ "command": "npx", "args": [...] }` | newline-delimited JSON on a child process |
| `http` | `{ "url": "https://…/mcp" }` | Streamable HTTP: POST per request, JSON or single-use SSE response, `Mcp-Session-Id` echoed |
| `sse` | `{ "url": "…/sse", "transport": "sse" }` | GET stream announces the POST endpoint; answers arrive as `message` events |

Discovered tools are wrapped as `mcp__<server>__<tool>`. A duplicate name is
skipped with a warning instead of aborting startup. `annotations.readOnlyHint`
makes the wrapped tool eligible for parallel execution.

## Skills

`.agents/skills/<name>/SKILL.md` (project) and `~/.carls/skills/` (user) override
the bundled catalog in `skills/`. The model sees a capped index in the system
prompt and loads a body with `use_skill`; `save_skill` writes a new one. The
usage ledger at `.carls/skill-usage.json` powers `/skills review`.

## Interface invariants

These are the rules that keep the terminal layout from corrupting itself:

- **stdout is the answer, stderr is everything else.** Diagnostics, spinners,
  tool streaming and permission prompts go to stderr, so `carls -p "…" | jq`
  works.
- **All width math goes through `Text.ts`** (`visibleWidth`, `truncate`, `pad`,
  `wrap`). Counting escape sequences as characters makes a line one column too
  wide, which wraps in the terminal, adds a row `Chrome` does not know about, and
  desyncs the scrolling region by one row on every scroll.
- `bannerLines` must return lines that fit; tests assert this across widths.
- `Chrome` owns the fixed header, the scrolling region (DECSTBM) and the footer
  rows. Nothing else may write raw newlines in that area.
- Colour comes from `Theme.ts` (`theme().paint(token, text)`), never raw
  `picocolors` in view modules. `paint` degrades truecolor → 256 → plain, and
  `NO_COLOR`/non-TTY drop colour.
- Tool calls render through `ToolView` as a glyph line plus a bounded block, not
  raw JSON. Deferred tools (`write_file`, `edit_file`, `apply_patch`,
  `write_many`) suppress the call line and carry the path on the result.

## Installer and updater

Both installers are **self-bootstrapping**: piped from `curl`/`irm` they have no
checkout beside them, so they download the requested ref
(`--ref`, default `main`), extract it and re-exec themselves from that tree.

`src/update/Updater.ts` compares `packageVersion()` with the latest GitHub
release, falls back to the newest tag when no release exists, and re-runs the
installer pinned to that tag. `installerPlan` is pure, so the update path is
tested without executing an installer.

## Module map

| Path | Responsibility |
| --- | --- |
| `src/core/AgentLoop.ts` | gather-act-verify loop, parallel batching, observation truncation |
| `src/core/ContextManager.ts` | token budget, compaction, safe cut, checkpoint fallback |
| `src/core/Runtime.ts` | wiring: tools, provider, gate, sub-agents, system prompt |
| `src/core/SubAgent.ts` | isolated read-only nested loop |
| `src/core/SessionStore.ts` | transcripts on disk, `/resume` |
| `src/core/Backups.ts` | snapshots that make `/undo` work |
| `src/core/CostTracker.ts` | token and spend accounting |
| `src/core/Hooks.ts` | `preToolUse` / `postToolUse` / session hooks |
| `src/tools/` | one file per tool, schema derived from zod |
| `src/providers/` | registry, dispatch, retry, model discovery |
| `src/mcp/` | protocol client and transports |
| `src/cli/` | REPL, Chrome layout, prompt, palette, renderers, commands |
| `src/security/PermissionGate.ts` | the six permission modes |
| `src/skills/` | discovery and usage ledger |
| `src/update/Updater.ts` | release check and tag-pinned update |
| `scripts/` | installers and shared shell helpers |

## Tests

`tests/smoke.test.ts` exercises real code paths: real filesystem, real `bash`,
and a scripted in-process `Provider` for `AgentLoop` (no network, no API key).
Useful pattern for a new tool: register it in a `ToolRegistry`, build a
`ToolContext` with a temp `cwd`, and assert on `ToolResult` rather than on text
output.

```bash
npm run typecheck && npm test
```
