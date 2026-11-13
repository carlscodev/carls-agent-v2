# Capability status

An honest inventory, kept so nobody has to guess what is actually implemented.
"Parity" here means the feature exists and is tested, not that it matches another
project line by line. Nothing in this repository is copied from another agent; the
terminal vocabulary (glyphs, panels, mode cycling) is our own.

## Working today

| Area | Status |
| --- | --- |
| Agent loop | gather → act → verify, `--max-steps`, abort mid-turn |
| Parallel read-only tools | up to 6 concurrent calls per turn |
| Context compaction | 75% threshold, tool-pair-safe cut, checkpoint summary, `/compact` |
| Compaction pipeline | 5 layers (artifact budget, superseded-read snip, masking, collapsed view, summary); layer 5 re-anchors the live state into the summary message |
| Observation masking | old tool results replaced by a one-line digest before compaction; failures and the recent window stay verbatim |
| Repository map | `repo_map` indexes symbols and signatures (regex, no new deps) and answers `find`/`dependents` queries under a token budget |
| Sub-agents | `delegate_task`, read-only, no nesting, structured report, four roles (explorer/planner/auditor/tester) |
| Sub-agent pool | `delegate_task` with a `tasks` array runs up to 6 children, 3 at a time, in request order; a failing child does not fail the batch |
| Checkpoints | `ShadowGit` snapshots the tree to a private git ref without touching the user's index or HEAD; `/checkpoint` and `/rewind` |
| Sessions | persisted transcripts, `/resume`, `/sessions` picker |
| Undo / redo | per-file snapshots behind `/undo`, session redo stack behind `/redo` |
| `@file` mentions | `@` opens a picker over tracked files; the content rides along in the message, capped at 8 files / 60k chars. Works in the REPL and in `carls -p` |
| Agent presets | `.agents/agents/<name>.md` with mode/tools/model/effort frontmatter and a `permission:` block (edit, webfetch, bash patterns); `--agent <name>` and `/agents` |
| Steer | Enter during a turn folds the message into that turn at the next step boundary; a late one is queued (`↑n` in the footer) |
| Web reading | `web_fetch` (HTML reduced to text, title included) and `web_search` over DuckDuckGo's keyless HTML endpoint |
| Export | `/export [path]` writes the transcript as markdown, tool calls and results included |
| LSP | `lsp` speaks JSON-RPC to the configured server: diagnostics, hover and definition, without a build |
| External editor | `/editor` composes the prompt in `$VISUAL`/`$EDITOR` and hands it back to the input line |
| Providers | 33 bundled ids, custom gateway via `baseUrl`, Ollama/LM Studio/vLLM/llama.cpp |
| Models | `/models` against the live endpoint, effort plumbing |
| Permissions | 6 modes, allow/deny lists, diff preview, `Shift+Tab` |
| MCP | stdio, SSE and Streamable HTTP, remote auth, `/mcp` |
| Skills | discovery from 3 layers, usage ledger, review queue, `save_skill` |
| Tools | 62 built-in, plus MCP tools, all zod-schema'd |
| LSP | diagnostics, hover, definition, code actions, and `lsp_edit` applying renames and quick fixes across files |
| Hooks | `preToolUse` / `postToolUse` / session events, plus the plugin API's `tool.execute.before` / `tool.execute.after` / `session.idle` with input rewrite and observation override |
| Plan / todo | `todo_write`, `/todo` |
| Persistent plan | `PersistentTaskDAG` survives a restart under `.carls/state/dag.json`; `plan_task`/`advance_task`/`read_task_graph`/`resume_task`, `/plan` |
| Skill evolution | curation gate, versioning, dependency graph, `evolve_skill`/`review_skills`/`skill_history`/`revert_skill`/`skill_graph` |
| Operator symbiosis | mid-run message classified as correction/approval/stop/question; corrections teach a persistent rule set (`/rules`); `ExecutionReceipt` behind `/receipt` |
| Terminal UI | fixed header, scrolling region, boxed panels, diffs, markdown stream, palette |
| Themes | dark/light, 256-colour and no-colour degradation |
| Print mode | stdout answer only, pipeable |
| Install | one-line curl (Linux/macOS) and PowerShell (Windows), self-bootstrapping |
| Native Windows binary | `npm run build:exe` emits one `carls.exe` (Node SEA) plus `carls.cmd`; `--install-win` copies it to `%LOCALAPPDATA%\carls\bin` and adds that directory to the user `Path` |
| Updates | `carls update`, tag-pinned, cached startup notice |
| Diagnostics | `/doctor` covering config, credentials, endpoint, MCP, updates |
| CI | Linux + macOS on Node 20/22/24, installer end to end on both, Windows job for build + CLI + PowerShell installer |
| Releases | tag-driven; the release is what `carls update` reads, installers attached |

## Missing, in the order I would build it

1. **Session tabs and a sidebar.** One session on screen at a time today.
2. **Headless server + remote client.** The runtime is embeddable, but there is
   no HTTP/WS server mode.
3. **Custom keybinds and per-project TUI config.**
4. **Share links.** `/export` writes a local file; there is no hosted share URL.
5. **In-process plugins.** The hooks are shell commands (the same events,
   payloads and JSON contract) rather than JS modules loaded into the runtime.

## Ground rules for closing the list

- Nothing lands without a test in `tests/smoke.test.ts` and a clean
  `npm run typecheck`.
- No feature is announced before it is verified end to end, including the
  installer and update paths.
- The interface invariants in `docs/architecture.md` are not negotiable: stdout
  stays the answer, width math goes through `Text.ts`, and a banner line never
  exceeds the terminal width.
