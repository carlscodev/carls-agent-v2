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

### Observation masking

Truncation bounds one observation; masking bounds their sum. Before compaction
is considered, `maskObservations` replaces the *content* of tool results older
than the recent window with a one-line digest:

```
[observation masked · ok · exit 0 · 2 lines, 5014 chars]
```

This is the cheap pass, and it runs first because it is strictly safer than
compaction: the message array keeps its length and order, so every `tool_result`
still sits directly after its `tool_use` and the provider never rejects the
request. `digest` keeps whatever is decision-relevant — exit code, test tallies,
error counts, diff hunk counts — and drops the raw body. Observations marked
`is_error` and the newest `keepRecent` messages are never masked, so a failure
the agent is still working on keeps its full text.

Compaction remains the fallback for when masking alone is not enough.

### The compaction pipeline and live-state re-anchoring

`CompactionPipeline` wraps the `ContextManager` in five layers and is what the
loop actually calls when the threshold is crossed. Layers 1–4 are cheap: a
tool-output budget offloaded to `.carls/artifacts`, a snip of reads that a later
edit superseded, masking, and a collapsed view. Only when those are not enough
does layer 5 pay for a model-written summary.

A summary of a long task is exactly where a model starts inventing: it forgets
which node it was on, re-edits a file it already fixed, or asks a question the
user answered forty turns ago. The fix is not a better summary but re-injecting
the state that must be true, read from the objects that own it rather than from
the transcript. `buildLiveState` renders that block — the verbatim goal, the
task graph, the operator rules, the project instructions — and the pipeline
appends it as the last text block of the summary message. Appending rather than
inserting a second message avoids emitting two consecutive user turns, which
some providers reject.

## The task horizon

Long work outlives a context window and often a process. `PersistentTaskDAG`
holds the plan as nodes with acceptance criteria, dependencies and verify
commands, and writes it to `.carls/state/dag.json` after every mutation, so a
restart resumes where it stopped (`plan_task`, `advance_task`,
`read_task_graph`, `resume_task`). A node must pass through `verifying` before
it can be `completed`; `TaskHorizonRouter` splits an operator instruction into
the clauses it actually contains, so "do X and then Y" becomes two asks rather
than one.

## Operator symbiosis

`AutoReviewSteeringClassifier` sorts a mid-run message into one of four intents
— correction, approval, stop, question — because they are not interchangeable. A
correction interrupts and teaches `OperatorCognitiveMemory`, which persists the
lesson under `.carls/` and re-injects it after a compaction; an approval is not
forwarded at all, since it would read as a new instruction and derail the turn.
When a turn ends, `ExecutionReceipt` records what changed, what was verified and
what was rolled back, assembled from the backup manifest and the task graph
rather than the model's own account (`/receipt`).

## Sub-agents

`delegate_task` runs nested `AgentLoop`s under `SubAgent`:

- read-only registry, `mode: "auto"`, its own step budget;
- no `spawnSubAgent` in its tool context, which caps nesting;
- its conversation is discarded; only a JSON report
  (`summary`, `findings`, `relevantFiles`, `suggestedCommands`) returns.

A sub-agent takes a **role**, which sets its instructions and step budget:

| role | for | steps |
| --- | --- | --- |
| `explorer` | map where code lives and how it connects | 15 |
| `planner` | turn a goal into an ordered, concrete plan | 12 |
| `auditor` | hunt bugs, leaks, unhandled errors, dead code | 20 |
| `tester` | find the test command and what is untested | 15 |

Passing a `tasks` array to `delegate_task` runs several sub-agents through
`SubAgentPool`, capped at `concurrency` (3) in flight and `maxTasks` (6) per
call. Each child is an independent conversation, so the pool is capped well
below the tool fan-out limit of 6. Outcomes come back in request order, and a
child that throws becomes `ok: false` with its error rather than failing the
batch — the same containment `runToolUse` gives a single tool call.

## Checkpoints

`ShadowGit` snapshots the whole working tree as a git commit on
`refs/carls/checkpoints/*`. `/undo` reverts one file from the backup manifest;
a checkpoint answers the different question of "put the tree back the way it
was".

Three properties make it safe inside a repository that is not carls's:

1. **The user's index is never touched.** Every git call runs with its own
   `GIT_INDEX_FILE` in the temp directory, so a checkpoint cannot stage or
   unstage anything. Verified by test.
2. **HEAD and the branch never move.** Checkpoints are commits on a private ref
   that no branch points at, so `git log` and `git status` are unchanged.
3. **Creation is additive.** `git add -A` honours `.gitignore`, so untracked
   files are captured but build output is not, and nothing is deleted.

`rewind` is the destructive half. It repoints the private index at the
checkpoint tree, materialises it with `checkout-index -a -f`, and deletes files
that exist now but not in the checkpoint. `/rewind` takes a safety checkpoint
before every rewind, so a rewind is itself undoable with `/rewind <new id>`.
Outside a git repository the whole subsystem is inert.

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

## Continuous integration

`.github/workflows/ci.yml` runs three jobs:

| Job | OS | What it proves |
| --- | --- | --- |
| `test` | Ubuntu, macOS · Node 20, 22, 24 | typecheck, the whole suite, build, CLI smoke (`--help`, `--providers`, `--doctor`, `update --dry-run`) |
| `installer` | Ubuntu, macOS | `scripts/test-install.sh`: install into a temp prefix, run the launcher, check config and skills, uninstall and assert cleanup |
| `windows` | Windows Server | typecheck, build, the line-ending tests, the CLI itself and `scripts/install.ps1` end to end |

The vitest suite is POSIX-only on purpose: it shells out to real `bash` and uses
symbolic links and `chmod`, which do not behave the same way on Windows. The
Windows job runs `npm run test:eol`, the line-ending cases, which write CRLF
themselves and so guard the Windows editing path on any OS. It covers everything
else that is portable instead of pretending the rest passes.

`.github/workflows/release.yml` runs on a `v*` tag: it re-checks the tree,
fails if the tag and `package.json` disagree, and publishes a GitHub Release with
both installers attached. That release is what `carls update` reads.
